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
 * Parse a comma-separated JS function-call argument list into raw string
 * tokens. Respects single-quoted string literals (so commas inside `'57,000'`
 * don't split) and bracket/brace nesting (so commas inside `[{a:1, b:2}]`
 * also don't split). Returns trimmed token strings — quotes, nulls, numbers,
 * arrays, and objects are returned in source form.
 *
 * Used to parse both `addFormatedRecommendation('USD<br />204.30',null,'204.30',
 * '<em class=\"price\">0<\/em>...',null,'57,000',...)` and the structured
 * sibling `addRecommendation(7,0,null,'800',null,204.3,...,57000,...,
 * [{segmentInfoList:[{serviceLevel:800}]}])`.
 */
function parseCallArgs(text) {
  const args = [];
  let current = '';
  let inQuote = false;
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\' && i + 1 < text.length) {
      // Escape sequence — consume both characters as-is
      current += ch + text[i + 1];
      i += 2;
      continue;
    }
    if (ch === "'") {
      inQuote = !inQuote;
      current += ch;
      i++;
      continue;
    }
    if (!inQuote && (ch === '[' || ch === '{')) {
      depth++;
      current += ch;
      i++;
      continue;
    }
    if (!inQuote && (ch === ']' || ch === '}')) {
      depth--;
      current += ch;
      i++;
      continue;
    }
    if (ch === ',' && !inQuote && depth === 0) {
      args.push(current.trim());
      current = '';
      i++;
      continue;
    }
    current += ch;
    i++;
  }
  if (current.trim()) args.push(current.trim());
  return args;
}

/**
 * Parse a single addFormatedRecommendation() 6th argument into a miles
 * integer. ANA's arg format is a single-quoted number with optional comma
 * thousands separators (e.g. `'57,000'` or `'150,000'`). A literal `null`
 * or any non-numeric string returns null.
 */
function parseMilesArg(arg) {
  if (!arg || arg === 'null') return null;
  const m = arg.match(/^'(.*)'$/);
  if (!m) return null;
  if (!/^[\d,]+$/.test(m[1])) return null;
  const n = parseInt(m[1].replace(/,/g, ''), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Parse a numeric addRecommendation() argument. Accepts:
 *   - bare numbers:   `57000`, `204.3`, `0.0`
 *   - quoted strings: `'57,000'`, `'204.30'`
 *   - `null` / empty / non-numeric → returns null
 *
 * Used for arg 5 (USD taxes/fees) and arg 11 (miles) of addRecommendation,
 * which emits the canonical numeric values without HTML/currency markup.
 */
function parseNumericArg(arg) {
  if (arg == null) return null;
  let s = String(arg).trim();
  if (s === '' || s === 'null') return null;
  const m = s.match(/^'(.*)'$/);
  if (m) s = m[1];
  s = s.replace(/,/g, '');
  if (!/^-?\d+(?:\.\d+)?$/.test(s)) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Extract per-recommendation {miles, taxUsd} from ANA's flight results page,
 * keyed by recId (the second arg of `addRecommendation(...)`).
 *
 * Argument layout (verified against captured ANA HTML):
 *   addRecommendation(flightId, RECID, null, serviceLevel, null,
 *                     TAX_USD,          // arg 5  — co-pay in USD (numeric)
 *                     null, taxUsdAlt, false, 0, null,
 *                     MILES,            // arg 11 — required mileage (integer)
 *                     'NO_NO_RULE', ..., [segmentInfoList...]);
 *
 * Why we use addRecommendation and not addFormatedRecommendation:
 *   The formated variant emits HTML strings intended for the display layer
 *   and interleaves promo flags. The unformated call emits raw numbers in a
 *   stable positional layout regardless of partner-award flags or peak-season
 *   markers — much safer to read positionally.
 *
 * Why keyed by recId and not source-code position:
 *   ANA emits addRecommendation calls in recId order (0, 1, 2, ...). The
 *   page's flight cards render in display-sort order (typically confirmed
 *   first, then waitlisted). Those two orders frequently disagree, so any
 *   caller that maps "Nth bodyText flight section → Nth addRecommendation
 *   call" pulls the wrong row. Callers must look up by recId (read from
 *   the flight card's radio-button `data-value`) — see
 *   `extractFlightCardDataValues` and the parseFlightDetails inline logic.
 *
 * Returns a Map<recId, {miles, taxUsd}>. Calls missing recId or unparseable
 * miles/tax are skipped or have null values for the affected field.
 *
 * Exported for unit testing. The same logic is inlined inside
 * parseFlightDetails' page.evaluate callback because the browser context
 * can't import module exports — keep the two copies in sync.
 */
function extractRecommendationsByRecId(html) {
  const out = new Map();
  if (typeof html !== 'string' || html.length === 0) return out;
  const callRegex = /addRecommendation\(([\s\S]*?)\);/g;
  let match;
  while ((match = callRegex.exec(html)) !== null) {
    const args = parseCallArgs(match[1]);
    if (args.length < 12) continue;
    const recId = parseInt(args[1], 10);
    if (!Number.isFinite(recId)) continue;
    const milesNum = parseNumericArg(args[11]);
    const taxNum   = parseNumericArg(args[5]);
    const miles  = milesNum != null && Number.isInteger(milesNum) && milesNum > 0 ? milesNum : null;
    const taxUsd = taxNum  != null && taxNum  >= 0 ? Math.round(taxNum * 100) / 100 : null;
    out.set(recId, { miles, taxUsd });
  }
  return out;
}

/**
 * Extract the `data-value` attribute of each flight card's radio button on
 * the search results page, in DOM order. The data-value equals the recId
 * of the matching `addRecommendation` call — caller composes the two to get
 * per-flight miles/tax in the order they're displayed to the user.
 *
 * The radio sits inside `td.selectItineraryCheck` for each itinerary row;
 * we match the first `data-value="N"` attribute inside each such cell.
 *
 * Returns an array of integers in DOM order, with NaN for any card whose
 * data-value couldn't be parsed (kept rather than dropped so positional
 * alignment with bodyText flight sections is preserved).
 *
 * Exported for unit testing. The parseFlightDetails inline equivalent uses
 * document.querySelectorAll instead of regex — same semantics either way.
 */
function extractFlightCardDataValues(html) {
  if (typeof html !== 'string' || html.length === 0) return [];
  const out = [];
  const cardRegex = /<td[^>]*class="[^"]*selectItineraryCheck[^"]*"[^>]*>[\s\S]*?data-value="(\d+)"/g;
  let m;
  while ((m = cardRegex.exec(html)) !== null) {
    out.push(parseInt(m[1], 10));
  }
  return out;
}

/**
 * Convenience: produce per-flight {miles, taxUsd} in DOM card order by
 * composing extractRecommendationsByRecId with extractFlightCardDataValues.
 * This is what the parseFlightDetails inline code does, exposed as a pure
 * helper for unit testing against real-HTML fixtures.
 *
 * Returns an array of `{ miles, taxUsd }` in the same order as the flight
 * cards appear on the page. Entries are `{ miles: null, taxUsd: null }`
 * when the card's data-value or its recommendation row couldn't be resolved.
 */
function extractPerFlightByCard(html) {
  const recsByRecId = extractRecommendationsByRecId(html);
  const dataValues = extractFlightCardDataValues(html);
  return dataValues.map(dv => recsByRecId.get(dv) || { miles: null, taxUsd: null });
}

/**
 * DEPRECATED: returns addRecommendation data in source-code order, which
 * does NOT line up with the page's flight-card display order. Kept for
 * backward compatibility with older tests; new code should use
 * `extractPerFlightByCard` or compose the two helpers above.
 */
function extractPerFlightRecommendations(html) {
  if (typeof html !== 'string' || html.length === 0) return [];
  const results = [];
  const callRegex = /addRecommendation\(([\s\S]*?)\);/g;
  let match;
  while ((match = callRegex.exec(html)) !== null) {
    const args = parseCallArgs(match[1]);
    const milesNum = args.length > 11 ? parseNumericArg(args[11]) : null;
    const taxNum   = args.length > 5  ? parseNumericArg(args[5])  : null;
    const miles  = milesNum != null && Number.isInteger(milesNum) && milesNum > 0 ? milesNum : null;
    const taxUsd = taxNum  != null && taxNum  >= 0 ? Math.round(taxNum * 100) / 100 : null;
    results.push({ miles, taxUsd });
  }
  return results;
}

/**
 * Backward-compatible wrapper around the older addFormatedRecommendation-based
 * miles extraction. Kept for the legacy parser path and for unit tests.
 * Prefer `extractPerFlightRecommendations` for new code — it also returns
 * tax/fee values and uses the more robust numeric-arg source.
 */
function extractPerFlightMiles(html) {
  if (typeof html !== 'string' || html.length === 0) return [];
  const results = [];
  const callRegex = /addFormatedRecommendation\(([\s\S]*?)\)/g;
  let match;
  while ((match = callRegex.exec(html)) !== null) {
    const args = parseCallArgs(match[1]);
    results.push(args.length >= 6 ? parseMilesArg(args[5]) : null);
  }
  return results;
}

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

  // ANA's 96-hour booking deadline error — date is too close to departure
  if (bodyText.includes('E_A01P01_0008') || bodyText.includes('application deadline has passed')) {
    return [{ noResults: true, unbookable: true, reason: '96-hour booking deadline' }];
  }

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
    const html = document.documentElement?.outerHTML || '';
    const results = [];

    // --- Per-flight miles + tax extraction ---
    // ANA only renders the "Required mileage" label for the currently-selected
    // flight in the DOM. Per-flight data lives in inline JS calls:
    //
    //   addRecommendation(flightId, RECID, null, serviceLevel, null,
    //                     TAX_USD, null, taxUsdAlt, false, 0, null,
    //                     MILES, 'NO_NO_RULE', ..., [segmentInfoList...]);
    //
    // Arg layout:
    //   arg  1 = recId (matches the flight card's radio data-value)
    //   arg  5 = tax/fees in USD (numeric, e.g. 174.43)
    //   arg 11 = required mileage (integer, e.g. 30000)
    //
    // CRITICAL: ANA emits these calls in recId order (0, 1, 2, ...). The
    // page's flight cards render in display-sort order (typically confirmed
    // first, then waitlisted), which frequently disagrees with recId order.
    // We MUST look up each flight card's miles/tax via its radio button's
    // `data-value` attribute (= recId), not by sequential position in the
    // call list. Live capture proved this: UA872 TPE→SFO 6/25 has data-value
    // 4, and sequential mapping (slot 0 → call slot 0) pulled the wrong row
    // (22,500) instead of recId 4's actual 30,000.
    //
    // NOTE: The helpers below are duplicated from parser.js module scope
    // (parseCallArgs, parseNumericArg, extractRecommendationsByRecId,
    // extractFlightCardDataValues) because page.evaluate runs in the browser
    // context and can't import module exports. Keep them in sync — unit tests
    // exercise the exported copies so any drift will be caught.
    const parseCallArgs = (text) => {
      const args = [];
      let current = '';
      let inQuote = false;
      let depth = 0;
      let i = 0;
      while (i < text.length) {
        const ch = text[i];
        if (ch === '\\' && i + 1 < text.length) {
          current += ch + text[i + 1];
          i += 2;
          continue;
        }
        if (ch === "'") { inQuote = !inQuote; current += ch; i++; continue; }
        if (!inQuote && (ch === '[' || ch === '{')) { depth++; current += ch; i++; continue; }
        if (!inQuote && (ch === ']' || ch === '}')) { depth--; current += ch; i++; continue; }
        if (ch === ',' && !inQuote && depth === 0) {
          args.push(current.trim());
          current = '';
          i++;
          continue;
        }
        current += ch;
        i++;
      }
      if (current.trim()) args.push(current.trim());
      return args;
    };
    const parseNumericArg = (arg) => {
      if (arg == null) return null;
      let s = String(arg).trim();
      if (s === '' || s === 'null') return null;
      const m = s.match(/^'(.*)'$/);
      if (m) s = m[1];
      s = s.replace(/,/g, '');
      if (!/^-?\d+(?:\.\d+)?$/.test(s)) return null;
      const n = parseFloat(s);
      return Number.isFinite(n) ? n : null;
    };

    // Build a Map<recId, {miles, taxUsd}> from every addRecommendation call.
    const recsByRecId = new Map();
    const callRegex = /addRecommendation\(([\s\S]*?)\);/g;
    let cm;
    while ((cm = callRegex.exec(html)) !== null) {
      const args = parseCallArgs(cm[1]);
      if (args.length < 12) continue;
      const recId = parseInt(args[1], 10);
      if (!Number.isFinite(recId)) continue;
      const milesNum = parseNumericArg(args[11]);
      const taxNum   = parseNumericArg(args[5]);
      const miles  = milesNum != null && Number.isInteger(milesNum) && milesNum > 0 ? milesNum : null;
      const taxUsd = taxNum  != null && taxNum  >= 0 ? Math.round(taxNum * 100) / 100 : null;
      recsByRecId.set(recId, { miles, taxUsd });
    }

    // Query each flight card's radio data-value in DOM order. This list lines
    // up positionally with the bodyText "Flight" sections we'll iterate below.
    const cardDataValues = Array.from(document.querySelectorAll('td.selectItineraryCheck'))
      .map(td => {
        const radio = td.querySelector('i[role="button"]');
        if (!radio) return null;
        const dv = parseInt(radio.getAttribute('data-value'), 10);
        return Number.isFinite(dv) ? dv : null;
      });
    let cardIndex = 0;

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

      // Per-flight miles + tax: look up the addRecommendation entry whose
      // recId equals this flight card's radio data-value. NEVER index by
      // position — see the header comment for why sequential mapping pulls
      // the wrong row for non-trivial display sorts.
      const recId = cardDataValues[cardIndex];
      cardIndex++;
      const rec = (recId != null && recsByRecId.has(recId))
        ? recsByRecId.get(recId)
        : { miles: null, taxUsd: null };
      const miles = rec.miles;
      const taxUsd = rec.taxUsd;

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
        miles,
        taxUsd,
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

module.exports = {
  parseResults, parseFlightDetails, getPageDebugInfo,
  // Pure helpers exposed for unit testing (same logic is inlined inside
  // parseFlightDetails' page.evaluate callback because browser context can't
  // import module exports — tests catch drift between the two copies).
  extractRecommendationsByRecId, extractFlightCardDataValues, extractPerFlightByCard,
  extractPerFlightRecommendations, extractPerFlightMiles,
  parseCallArgs, parseMilesArg, parseNumericArg,
};
