/**
 * Parse ANA award search results page for flight availability.
 * 
 * ANA results formats:
 * 1. Calendar comparison view (前後3日の空席を比較) — shows ±3 days with ○/×/△ symbols
 * 2. Flight list view — individual flights with times, stops, and cabin availability
 * 3. "No results" error page — E_A01P01_0006
 * 
 * Availability symbols:
 *   ○ = Confirmed seats available
 *   △ = Waitlist only
 *   × = No availability
 *   ― = Not applicable
 */

const fs = require('fs');
const path = require('path');

/**
 * Extract flight availability from the search results page.
 * @param {Page} page - Puppeteer page
 * @param {string} cabinName - The cabin class being searched (for context)
 * @returns {Array} parsed results
 */
async function parseResults(page, cabinName = 'Economy') {
  // First, dump raw HTML to file for debugging when we find interesting results
  const bodyText = await page.evaluate(() => document.body?.innerText || '');
  const pageUrl = await page.url();

  // Quick "no results" check before heavy parsing
  const noResultPatterns = [
    '合うものがありませんでした',
    'E_A01P01_0006',
    '該当する便がありません',
    'no flights available',
    'no award seats',
  ];
  if (noResultPatterns.some(p => bodyText.includes(p))) {
    return [{ noResults: true }];
  }

  // Save HTML when we DO find results (for future parser tuning)
  const hasAvailabilityMarkers = bodyText.includes('○') || bodyText.includes('△') || 
                                  bodyText.includes('空席あり') || bodyText.includes('Available');
  if (hasAvailabilityMarkers) {
    const htmlDump = await page.evaluate(() => document.body?.innerHTML || '');
    const dumpPath = path.join(__dirname, '..', 'data', `results-html-${Date.now()}.html`);
    try { fs.writeFileSync(dumpPath, htmlDump); } catch(e) {}
    console.log(`[Parser] Saved results HTML to ${dumpPath}`);
  }

  return page.evaluate((cabinNameArg) => {
    const results = [];
    const bodyText = document.body.innerText || '';
    const pageUrl = window.location.href;

    // === FORMAT 1: Calendar comparison view ===
    // The calendar view shows dates in a grid with availability symbols/text
    if (pageUrl.includes('calendar') || bodyText.includes('空席を比較') ||
        bodyText.includes('前後') || bodyText.includes('カレンダー') ||
        bodyText.includes('Compare seat availability')) {

      // Pattern 1: Japanese dates with symbols
      // "4月5日\n（日）\n○" or "4月5日（日）○"
      const jpPattern = /(\d{1,2})月(\d{1,2})日\s*[（(]([日月火水木金土])[）)]\s*([○△×―]|空席あり|空席なし|満席)/g;
      let match;
      while ((match = jpPattern.exec(bodyText)) !== null) {
        const month = parseInt(match[1]);
        const day = parseInt(match[2]);
        const dayOfWeek = match[3];
        const symbol = match[4];

        const available = symbol === '○' || symbol === '空席あり';
        const waitlist = symbol === '△';

        results.push({
          month, day, dayOfWeek,
          available,
          waitlist,
          confirmed: available && !waitlist,
          cabin: cabinNameArg,
          symbol,
          depTime: '', arrTime: '',
          stops: [],
          layover: null,
          rawText: match[0],
          format: 'calendar',
        });
      }

      // Pattern 2: English calendar dates (with newlines between parts)
      // Actual format: "Oct 15\n(Thu)\nSeats available" or "Oct 15\n(Thu)\n×"
      const enPattern = /(\w{3})\s+(\d{1,2})\s*\n?\s*\((\w{2,3})\)\s*\n?\s*([○△×―]|Seats available|Seats unavailable|Unavailable|Available|Waitlist|No seats)/gi;
      while ((match = enPattern.exec(bodyText)) !== null) {
        const statusText = match[4];
        const available = /available/i.test(statusText) || statusText === '○';
        const waitlist = statusText === '△' || /waitlist/i.test(statusText);
        const noSeats = statusText === '×' || /unavailable|no seats/i.test(statusText);

        results.push({
          monthName: match[1],
          day: parseInt(match[2]),
          dayOfWeek: match[3],
          available,
          waitlist,
          confirmed: available && !waitlist,
          cabin: cabinNameArg,
          symbol: available ? '○' : (waitlist ? '△' : '×'),
          depTime: '', arrTime: '',
          stops: [],
          layover: null,
          rawText: match[0].replace(/\n/g, ' '),
          format: 'calendar-en',
        });
      }

      if (results.length > 0) return results;
    }

    // === FORMAT 2: Flight list view ===
    // Individual flights with details — times, routing, availability per cabin
    // ANA uses various container classes; try broad selectors
    const flightContainers = document.querySelectorAll(
      '.searchResultItem, .flight-result, .result-row, ' +
      'table.result tbody tr, .flightInfoArea, .boardingInfoArea, ' +
      '[class*="result"][class*="flight"], [class*="search"][class*="result"], ' +
      '[class*="flightResult"], [class*="routeInfo"], .itineraryArea'
    );

    if (flightContainers.length > 0) {
      flightContainers.forEach(container => {
        try {
          const text = container.innerText || '';
          
          // Extract departure and arrival times
          const timeMatch = text.match(/(\d{1,2}:\d{2})\s*[-–→~]\s*(\d{1,2}:\d{2})/);
          const depTime = timeMatch ? timeMatch[1] : '';
          const arrTime = timeMatch ? timeMatch[2] : '';

          // Extract airport codes to determine stops/layovers
          const airportCodes = [];
          const codeMatches = text.matchAll(/\b([A-Z]{3})\b/g);
          for (const cm of codeMatches) {
            const code = cm[1];
            // Filter out non-airport 3-letter codes
            if (!['ANA', 'JAL', 'EVA', 'SIN', 'THE', 'FOR', 'AND', 'ALL'].includes(code)) {
              airportCodes.push(code);
            }
          }
          // Unique ordered codes represent the route
          const routeCodes = [...new Set(airportCodes)];
          
          // Determine if layover exists (more than 2 unique airport codes = has stops)
          const hasLayover = routeCodes.length > 2;
          const stopCodes = hasLayover ? routeCodes.slice(1, -1) : [];

          // Check for availability symbols
          const hasConfirmed = text.includes('○') || text.includes('●');
          const hasWaitlist = text.includes('△');
          const hasAvailable = hasConfirmed || hasWaitlist || text.includes('空席あり');

          // Extract duration if present
          const durationMatch = text.match(/(\d{1,2})時間(\d{1,2})分/) || text.match(/(\d{1,2})h\s*(\d{1,2})m/i);
          const duration = durationMatch ? `${durationMatch[1]}h${durationMatch[2]}m` : '';

          // Extract flight number
          const flightNumMatch = text.match(/\b(NH|UA|BR|SQ|TG|CA)\s*(\d{2,4})\b/);
          const flightNumber = flightNumMatch ? `${flightNumMatch[1]}${flightNumMatch[2]}` : '';

          if (hasAvailable) {
            results.push({
              available: true,
              confirmed: hasConfirmed,
              waitlist: hasWaitlist && !hasConfirmed,
              cabin: cabinNameArg,
              symbol: hasConfirmed ? '○' : (hasWaitlist ? '△' : '?'),
              depTime, arrTime,
              duration,
              flightNumber,
              route: routeCodes,
              stops: stopCodes,
              layover: hasLayover,
              rawText: text.substring(0, 500),
              format: 'flight-list',
            });
          }
        } catch (e) {}
      });
    }

    // === FALLBACK: Broad text search ===
    if (results.length === 0) {
      // Check for any availability markers in the entire page
      if (bodyText.includes('○') || bodyText.includes('空席あり')) {
        results.push({
          available: true,
          confirmed: bodyText.includes('○'),
          waitlist: bodyText.includes('△'),
          cabin: cabinNameArg,
          symbol: bodyText.includes('○') ? '○' : '△',
          depTime: '', arrTime: '',
          stops: [],
          layover: null,
          rawText: bodyText.substring(0, 800),
          format: 'fallback',
        });
      } else if (bodyText.includes('△')) {
        results.push({
          available: false,
          confirmed: false,
          waitlist: true,
          cabin: cabinNameArg,
          symbol: '△',
          depTime: '', arrTime: '',
          stops: [],
          layover: null,
          rawText: bodyText.substring(0, 800),
          format: 'fallback',
        });
      }
    }

    return results;
  }, cabinName);
}

/**
 * Parse the flight detail/results page for individual itineraries.
 *
 * Format (line by line):
 *   FlightNH007,BR195          ← itinerary header
 *   [Waitlisted]               ← optional waitlist marker
 *   San Francisco              ← leg 1 departure city
 *   11:00                      ← departure time
 *   Terminal: INT               ← optional terminal
 *   Tokyo (Narita)             ← leg 1 arrival city
 *   15:20+1day                 ← arrival time
 *   NH007 77W Seat Map         ← flight + aircraft
 *   Economy Class              ← cabin class for this leg
 *   Dec 5 (Sat)                ← date separator for next leg
 *   Tokyo (Narita)             ← leg 2 departure city
 *   ...
 *   Total travel time 20h25min ← duration
 */
async function parseFlightDetails(page, cabinName = 'Business') {
  return page.evaluate((cabinNameArg) => {
    const bodyText = document.body?.innerText || '';
    const results = [];

    // Split by "Flight" prefix
    const sections = bodyText.split(/(?=Flight[A-Z]{2}\d)/);

    for (const section of sections) {
      if (!section.startsWith('Flight')) continue;

      const lines = section.split('\n').map(l => l.trim()).filter(Boolean);

      // Extract flight numbers
      const flightMatch = lines[0].match(/Flight((?:[A-Z]{2}\d{1,4},?)+)/);
      if (!flightMatch) continue;
      const flights = flightMatch[1].split(',');

      const isWaitlisted = lines.some(l => l === 'Waitlisted');

      // Parse legs by scanning lines
      const legs = [];
      let i = 1; // skip header line
      while (i < lines.length) {
        const line = lines[i];

        // Skip non-city lines
        if (line === 'Waitlisted' || line.startsWith('Award Type') ||
            line.startsWith('Can be used') || line.startsWith('Total travel') ||
            line.startsWith('Self-arranged') || /^\w{3} \d{1,2} \(\w{3}\)$/.test(line)) {
          i++;
          continue;
        }

        // Detect start of a leg: a city name (letters, spaces, parens) followed by a time
        const isCity = /^[A-Z][A-Za-z ()-]+$/.test(line) && !line.startsWith('Terminal');
        const nextLine = lines[i + 1] || '';
        const isTime = /^\d{1,2}:\d{2}/.test(nextLine);

        if (isCity && isTime) {
          const fromCity = line;
          const depTime = nextLine.replace(/\+\d+day/, '');
          i += 2;

          // Skip terminal line
          if (lines[i] && lines[i].startsWith('Terminal:')) i++;

          // Next should be arrival city
          const toCity = lines[i] || '';
          i++;
          const arrTime = (lines[i] || '').replace(/\+\d+day/, '');
          i++;

          // Skip terminal
          if (lines[i] && lines[i].startsWith('Terminal:')) i++;

          // Flight code line: "NH007 77W Seat Map" or "BR195  781"
          const flightLine = lines[i] || '';
          const flightCodeMatch = flightLine.match(/^([A-Z]{2}\d{1,4})\s/);
          const flightCode = flightCodeMatch ? flightCodeMatch[1] : '';
          i++;

          // Check for "Operated by..." line
          let operatedBy = '';
          if (lines[i] && lines[i].startsWith('Operated by')) {
            operatedBy = lines[i];
            // Cabin class may be at the end: "Operated by EVA Airways Business Class"
            const cabinMatch = operatedBy.match(/(Economy|Business|First|Premium Economy)\s*Class/i);
            if (cabinMatch) {
              legs.push({ from: fromCity, depTime, to: toCity, arrTime, flight: flightCode, cabin: cabinMatch[1] + ' Class', operatedBy });
              i++;
              continue;
            }
            i++;
          }

          // Cabin class line: " Business Class" or "Economy Class"
          const cabinLine = lines[i] || '';
          const cabinMatch = cabinLine.match(/(Economy|Business|First|Premium Economy)\s*Class/i);
          const cabin = cabinMatch ? cabinMatch[1] + ' Class' : cabinLine;
          if (cabinMatch) i++;

          legs.push({ from: fromCity, depTime, to: toCity, arrTime, flight: flightCode, cabin, operatedBy });
        } else {
          i++;
        }
      }

      // Duration
      const durationMatch = section.match(/Total travel time (\d+h\d+min)/);
      const duration = durationMatch ? durationMatch[1] : '';

      // Build descriptions
      let routeDesc = '';
      let cabinDesc = '';
      if (legs.length > 0) {
        routeDesc = [legs[0].from, ...legs.map(l => l.to)].join(' → ');
        const cabins = [...new Set(legs.map(l => l.cabin))];
        if (cabins.length > 1) {
          cabinDesc = legs.map(l => `${l.flight}: ${l.cabin}`).join(', ');
        } else {
          cabinDesc = legs.map(l => `${l.flight} ${l.cabin}`).join(' + ');
        }
      }

      const isMixedCabin = legs.length > 1 && new Set(legs.map(l => l.cabin)).size > 1;

      results.push({
        available: !isWaitlisted,
        confirmed: !isWaitlisted,
        waitlist: isWaitlisted,
        cabin: cabinNameArg,
        symbol: isWaitlisted ? '△' : '○',
        flightNumber: flights.join('+'),
        depTime: legs[0]?.depTime || '',
        arrTime: legs[legs.length - 1]?.arrTime || '',
        duration,
        route: legs.length > 0 ? [legs[0]?.from, ...legs.map(l => l.to)] : [],
        stops: legs.length > 1 ? legs.slice(0, -1).map(l => l.to) : [],
        layover: legs.length > 1,
        legs,
        isMixedCabin,
        routeDesc,
        cabinDesc,
        rawText: section.substring(0, 300),
        format: 'flight-detail',
      });
    }

    return results;
  }, cabinName);
}

async function getPageDebugInfo(page) {
  return page.evaluate(() => ({
    title: document.title,
    url: window.location.href,
    bodyText: document.body?.innerText?.substring(0, 2000) || '',
    formCount: document.querySelectorAll('form').length,
    inputCount: document.querySelectorAll('input').length,
    selectCount: document.querySelectorAll('select').length,
  }));
}

module.exports = { parseResults, parseFlightDetails, getPageDebugInfo };
