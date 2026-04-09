require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { runParallel } = require('./session');
const { initDiscord, destroyDiscord, notifyAvailability, sendAlert, sendStatusUpdate } = require('./notifier');

const { ANA_USERNAME, ANA_PASSWORD } = process.env;
const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS || '2');
const SKIP_MIXED_CABIN = process.env.SKIP_MIXED_CABIN !== 'false'; // default: skip
const MAX_LAYOVER_HOURS = parseInt(process.env.MAX_LAYOVER_HOURS || '30');
const ALERT_WAITLIST = process.env.ALERT_WAITLIST !== 'false'; // default: alert waitlist too
const SKIP_KNOWN_AVAILABLE = process.env.SKIP_KNOWN_AVAILABLE !== 'false'; // default: skip
const RECHECK_HOURS = parseInt(process.env.RECHECK_HOURS || '4'); // re-check confirmed combos after this many hours

if (!ANA_USERNAME || !ANA_PASSWORD) {
  console.error('ERROR: ANA_USERNAME and ANA_PASSWORD are required in .env');
  process.exit(1);
}

const { loadRoutes } = require('./routes');

const STATE_FILE = path.join(__dirname, '..', 'data', 'state.json');
const ROUTES = loadRoutes();
const CABIN_PE  = { code: 'CFF4', name: 'Premium Economy' };
const CABIN_ECO = { code: 'CFF1', name: 'Economy' };
const CABIN_BIZ = { code: 'CFF2', name: 'Business' };

// Map storage key (routes.json) → search cabin object
const CABIN_BY_KEY = {
  'premium-economy': CABIN_PE,
  'economy':         CABIN_ECO,
  'business':        CABIN_BIZ,
};

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { lastCheck: null, flights: {} };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

/**
 * Generate a stable unique key for a flight itinerary.
 */
function flightKey(route, date, result) {
  // For detailed results: use flight numbers
  if (result.flightNumber) {
    return `${route}|${date}|${result.flightNumber}`;
  }
  // For calendar results: use day + cabin
  return `${route}|${date}|cal-${result.monthName || ''}${result.day || ''}-${result.cabin}`;
}

/**
 * Parse duration string to hours.
 */
function durationToHours(duration) {
  if (!duration) return 0;
  const match = duration.match(/(\d+)h(\d+)min/);
  if (match) return parseInt(match[1]) + parseInt(match[2]) / 60;
  return 0;
}

/**
 * Process results: smart deduplication, status change detection, filtering.
 */
function processResults(allResults, state) {
  let alertsSent = 0;
  const seenKeys = new Set(); // Track keys seen this run (to detect GONE flights)

  if (!state.flights) state.flights = {};

  for (const { route, cabin, date, results } of allResults) {
    if (!results || results.length === 0 || results[0]?.noResults) {
      continue;
    }

    for (const result of results) {
      if (!result.available && !result.waitlist) continue;

      // --- FILTERS ---
      // Skip mixed cabin unless configured otherwise
      if (SKIP_MIXED_CABIN && result.isMixedCabin) {
        console.log(`[Main] Skipped mixed cabin: ${route} ${date} ${result.flightNumber} (${result.cabinDesc})`);
        continue;
      }

      // Skip very long layovers
      const hours = durationToHours(result.duration);
      if (hours > MAX_LAYOVER_HOURS && result.layover) {
        console.log(`[Main] Skipped long layover: ${route} ${date} ${result.flightNumber} (${result.duration})`);
        continue;
      }

      // Skip waitlist if configured
      if (!ALERT_WAITLIST && result.waitlist) {
        continue;
      }

      // --- DEDUPLICATION & STATUS TRACKING ---
      const key = flightKey(route, date, result);
      seenKeys.add(key);
      const currentStatus = result.waitlist ? 'waitlist' : 'confirmed';
      const prev = state.flights[key];

      if (!prev) {
        // NEW flight — alert!
        console.log(`[Main] 🎉 NEW ${currentStatus}: ${route} ${date} ${result.flightNumber || result.cabin} ${result.routeDesc || ''}${result.miles ? ` (${result.miles.toLocaleString()} miles)` : ''}`);
        const sent = notifyAvailability(date, result, route);
        if (sent) alertsSent++;
        state.flights[key] = {
          firstSeen: new Date().toISOString(),
          lastSeen: new Date().toISOString(),
          status: currentStatus,
          route,
          date,
          searchedCabin: cabin, // Economy or Business — for skip-known-available logic
          flightNumber: result.flightNumber,
          routeDesc: result.routeDesc,
          cabinDesc: result.cabinDesc,
          duration: result.duration,
          miles: result.miles ?? null,
        };
      } else if (prev.status === 'waitlist' && currentStatus === 'confirmed') {
        // UPGRADE — was waitlisted, now confirmed! Alert!
        console.log(`[Main] 🎉 UPGRADE: ${route} ${date} ${result.flightNumber} waitlist → confirmed!`);
        const sent = notifyAvailability(date, { ...result, _statusChange: 'UPGRADED from waitlist' }, route);
        if (sent) alertsSent++;
        prev.status = 'confirmed';
        prev.lastSeen = new Date().toISOString();
        if (result.miles != null) prev.miles = result.miles;
      } else if (prev.status === 'confirmed' && currentStatus === 'waitlist') {
        // DOWNGRADE — was confirmed, now waitlist only
        console.log(`[Main] ⚠️ DOWNGRADE: ${route} ${date} ${result.flightNumber} confirmed → waitlist`);
        prev.status = 'waitlist';
        prev.lastSeen = new Date().toISOString();
        if (result.miles != null) prev.miles = result.miles;
        // Don't alert downgrades — too noisy
      } else {
        // STILL AVAILABLE — same status, don't alert
        prev.lastSeen = new Date().toISOString();

        // Detect and log miles price changes (useful signal — ANA can adjust
        // award pricing, and the user may want to know if a tracked flight
        // got cheaper or more expensive). Not an alert, just a log + persist.
        if (result.miles != null && prev.miles != null && result.miles !== prev.miles) {
          const delta = result.miles - prev.miles;
          const sign = delta > 0 ? '+' : '';
          console.log(`[Main] 💰 MILES CHANGED: ${route} ${date} ${result.flightNumber}: ${prev.miles.toLocaleString()} → ${result.miles.toLocaleString()} (${sign}${delta.toLocaleString()})`);
        }
        // Always refresh latest miles (handles backfill of legacy entries)
        if (result.miles != null) prev.miles = result.miles;
      }
    }
  }

  // GONE detection: when we re-check a (route, date, cabin) combo and a
  // previously-confirmed flight is no longer in the results, alert the user
  // and remove it from state.
  const searchedRouteDateCabin = new Set();
  for (const { route, cabin, date, results } of allResults) {
    if (results && results.length > 0 && !results[0]?._sessionFailed) {
      searchedRouteDateCabin.add(`${route}|${date}|${cabin}`);
    }
  }

  for (const [key, flight] of Object.entries(state.flights)) {
    if (!flight.searchedCabin) continue; // legacy entry without cabin info → leave alone
    const combo = `${flight.route}|${flight.date}|${flight.searchedCabin}`;
    if (searchedRouteDateCabin.has(combo) && !seenKeys.has(key)) {
      if (flight.status === 'confirmed') {
        console.log(`[Main] ❌ GONE: ${flight.route} ${flight.date} ${flight.flightNumber} was confirmed, now unavailable`);
        const milesLine = flight.miles ? `\nWas: ${flight.miles.toLocaleString()} miles` : '';
        sendAlert(`❌ **Seats gone**: ${flight.flightNumber} ${flight.route} ${flight.date}\n${flight.cabinDesc || ''} — no longer available${milesLine}`);
      }
      delete state.flights[key];
    }
  }

  return alertsSent;
}

async function main() {
  // Initialize Discord bot
  await initDiscord();

  console.log('[Main] ANA Award Tracker starting...');
  console.log(`[Main] ${MAX_SESSIONS} parallel sessions | mixed cabin: ${SKIP_MIXED_CABIN ? 'skip' : 'include'} | max layover: ${MAX_LAYOVER_HOURS}h | waitlist: ${ALERT_WAITLIST ? 'alert' : 'skip'}`);
  for (const route of ROUTES) {
    const dateList = Object.keys(route.dates || {}).sort().join(', ');
    console.log(`[Main] Route: ${route.from}→${route.to} on ${dateList}`);
  }

  const state = loadState();

  try {
    // Clean up expired dates first (anything before today PST)
    const { cleanupExpiredDates, loadRoutes: reloadRoutes } = require('./routes');
    const cleanup = cleanupExpiredDates();
    if (cleanup.removedDates.length > 0) {
      const summary = cleanup.removedDates.map(rd => `${rd.route} ${rd.date}`).join(', ');
      console.log(`[Main] 🗑️ Removed ${cleanup.removedDates.length} expired date(s): ${summary}`);
      await sendStatusUpdate(`🗑️ Auto-removed ${cleanup.removedDates.length} expired date(s): ${summary} (cleaned ${cleanup.removedFlights} cached flights)`);
    }

    // Reload routes after cleanup
    const activeRoutes = reloadRoutes();
    if (activeRoutes.length === 0) {
      console.log('[Main] No routes to search.');
      return;
    }

    // Check if session is known to be stale — don't waste time searching
    const { isStale, getStaleInfo } = require('./session-stale');
    if (isStale()) {
      const info = getStaleInfo();
      console.log(`[Main] Session is stale: ${info?.reason}. Skipping search.`);
      await sendStatusUpdate(`⏸️ Search skipped — session stale: ${info?.reason}\nLog in to ANA in Chrome to resume.`);
      return;
    }

    // Build set of (route, date, cabin) combos that have CONFIRMED flights
    // recently enough to skip re-checking. Waitlist does NOT count.
    const skipCombos = new Set();
    let skippedDueToConfirmed = 0;
    if (SKIP_KNOWN_AVAILABLE && state.flights) {
      const recheckMs = RECHECK_HOURS * 60 * 60 * 1000;
      const now = Date.now();
      for (const flight of Object.values(state.flights)) {
        if (flight.status !== 'confirmed') continue;
        if (!flight.searchedCabin) continue; // legacy entry without cabin info → don't skip
        const lastSeen = new Date(flight.lastSeen).getTime();
        if (now - lastSeen > recheckMs) continue; // stale → re-check to detect changes
        skipCombos.add(`${flight.route}|${flight.date}|${flight.searchedCabin}`);
      }
    }

    // Build search jobs from refreshed routes, filtering out skip combos.
    // Each (date, cabin) pair in a route's dates object becomes a task; we group
    // tasks by cabin into a single job-per-cabin for runParallel's batching.
    const jobs = [];
    for (const route of activeRoutes) {
      // Group: cabinName -> { code, name, dates: [] }
      const datesByCabin = new Map();
      for (const [date, cabinKeys] of Object.entries(route.dates || {})) {
        for (const key of cabinKeys) {
          const cabin = CABIN_BY_KEY[key];
          if (!cabin) continue; // unknown cabin key — skip silently
          const combo = `${route.from}→${route.to}|${date}|${cabin.name}`;
          if (skipCombos.has(combo)) {
            skippedDueToConfirmed++;
            continue;
          }
          if (!datesByCabin.has(cabin.name)) {
            datesByCabin.set(cabin.name, { code: cabin.code, name: cabin.name, dates: [] });
          }
          datesByCabin.get(cabin.name).dates.push(date);
        }
      }
      for (const { code, name, dates } of datesByCabin.values()) {
        if (dates.length > 0) {
          jobs.push({
            from: route.from,
            to: route.to,
            dates: dates.slice().sort(),
            cabinCode: code,
            cabinName: name,
          });
        }
      }
    }

    if (skippedDueToConfirmed > 0) {
      console.log(`[Main] Skipping ${skippedDueToConfirmed} task(s) — already confirmed within ${RECHECK_HOURS}h`);
    }

    // Note: keep-alive in Discord bot refreshes cookies every 25 min.
    // No pre-search refresh — that creates suspicious back-to-back browser launches.

    // Build expected task list (every route+date+cabin combo we plan to check)
    const expectedTasks = new Map(); // key = "route|date|cabin" → status
    for (const job of jobs) {
      for (const date of job.dates) {
        const key = `${job.from}→${job.to}|${date}|${job.cabinName}`;
        expectedTasks.set(key, 'skipped'); // default until proven otherwise
      }
    }
    const totalExpected = expectedTasks.size;

    // Run all searches in parallel
    const startTime = Date.now();
    if (!state.lastChecked) state.lastChecked = {};
    const allResults = await runParallel(jobs, MAX_SESSIONS, state.lastChecked);
    const elapsed = Math.round((Date.now() - startTime) / 1000);

    // Mark each task that was actually attempted
    let checkedCount = 0;
    let rateLimitedCount = 0;
    for (const r of allResults) {
      if (r._sessionFailed) continue;
      const key = `${r.route}|${r.date}|${r.cabin}`;
      if (expectedTasks.has(key)) {
        if (r._rateLimited) {
          expectedTasks.set(key, 'rate-limited');
          rateLimitedCount++;
        } else {
          expectedTasks.set(key, 'checked');
          state.lastChecked[key] = Date.now();
          checkedCount++;
        }
      }
    }

    // Anything still 'skipped' was never reached (session died before getting to it)
    const skippedTasks = [...expectedTasks.entries()].filter(([, s]) => s === 'skipped').map(([k]) => k);
    const skippedCount = skippedTasks.length;

    // Categorize session failures
    const sessionFailures = allResults.filter(r => r._sessionFailed);
    const rateLimitedSessions = sessionFailures.filter(f => f.rateLimited || f.error === 'RATE_LIMITED');
    const cookieIssues = sessionFailures.filter(f => !f.rateLimited && f.error !== 'RATE_LIMITED');
    if (sessionFailures.length > 0) {
      console.error(`[Main] ⚠️ ${sessionFailures.length} session(s) failed (${rateLimitedSessions.length} rate-limited, ${cookieIssues.length} cookie/login)`);
      if (cookieIssues.length > 0) {
        await sendAlert(`⚠️ ${cookieIssues.length} session(s) failed: ${cookieIssues[0].error}\nLog in to ANA in Chrome to refresh cookies.`);
      }
    }

    // Save coverage to state for /status (cap skippedKeys to avoid unbounded growth)
    state.lastCoverage = {
      timestamp: new Date().toISOString(),
      total: totalExpected,
      checked: checkedCount,
      rateLimited: rateLimitedCount,
      skipped: skippedCount,
      sessionsRateLimited: rateLimitedSessions.length,
      skippedSample: skippedTasks.slice(0, 20),
    };

    const validResults = allResults.filter(r => !r._sessionFailed);
    const alertsSent = processResults(validResults, state);
    state.lastCheck = new Date().toISOString();
    saveState(state);

    // Summary
    // Count only flights for currently-tracked routes/dates so this matches /status.
    // Also opportunistically prune orphaned entries (routes/dates removed since last run).
    const validRouteDates = new Set();
    for (const route of activeRoutes) {
      for (const date of Object.keys(route.dates || {})) {
        validRouteDates.add(`${route.from}→${route.to}|${date}`);
      }
    }
    let prunedOrphans = 0;
    for (const key of Object.keys(state.flights)) {
      const [route, date] = key.split('|');
      if (!validRouteDates.has(`${route}|${date}`)) {
        delete state.flights[key];
        prunedOrphans++;
      }
    }
    if (prunedOrphans > 0) {
      console.log(`[Main] Pruned ${prunedOrphans} orphaned flight(s) from state`);
    }

    const tracked = Object.keys(state.flights).length;
    const confirmed = Object.values(state.flights).filter(f => f.status === 'confirmed').length;
    const waitlisted = Object.values(state.flights).filter(f => f.status === 'waitlist').length;

    console.log(`\n[Main] Check complete in ${elapsed}s. ${alertsSent} new alert(s). Coverage: ${checkedCount}/${totalExpected} checked, ${rateLimitedCount} rate-limited, ${skippedCount} skipped. Tracking ${tracked} flights.`);

    // Build a readable coverage line for Discord
    let coverageMsg = `${checkedCount}/${totalExpected} checked`;
    if (rateLimitedCount > 0) coverageMsg += `, ${rateLimitedCount} rate-limited`;
    if (skippedCount > 0) coverageMsg += `, ${skippedCount} skipped`;
    if (skippedDueToConfirmed > 0) coverageMsg += `, ${skippedDueToConfirmed} skipped (already confirmed)`;
    if (rateLimitedSessions.length > 0) {
      coverageMsg += ` (${rateLimitedSessions.length} session${rateLimitedSessions.length > 1 ? 's' : ''} hit ANA throttle)`;
    }

    // List up to 10 skipped tasks so user can see what was missed
    let skippedDetail = '';
    if (skippedCount > 0) {
      const sample = skippedTasks.slice(0, 10).map(k => {
        const [route, date, cabin] = k.split('|');
        return `${route} ${date} ${cabin.charAt(0)}`;
      }).join(', ');
      skippedDetail = `\n⏭️ Skipped: ${sample}${skippedCount > 10 ? `, +${skippedCount - 10} more` : ''}`;
    }

    const now = new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit', hour12: true });
    const headline = alertsSent > 0
      ? `✅ ANA check @ ${now} — ${alertsSent} new alert(s)!`
      : `🔍 ANA check @ ${now} — no changes`;
    const statusMsg = `${headline}\nCoverage: ${coverageMsg}\nTracking: ${tracked} flights (${confirmed} confirmed, ${waitlisted} waitlist)${skippedDetail}`;
    await sendStatusUpdate(statusMsg);
  } catch (err) {
    console.error('[Main] Check failed:', err.message);

    if (err.rateLimited) {
      console.error('[Main] ⛔ Blocked by ANA/Akamai — cookies may need refresh');
      sendAlert('⛔ ANA blocked us. Re-export cookies via Chrome extension.');
      state.rateLimitedUntil = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
      saveState(state);
      process.exitCode = 2;
    } else {
      if (state.lastError && (Date.now() - new Date(state.lastError).getTime()) > 3600000) {
        sendAlert(`⚠️ ANA Award Tracker error: ${err.message.substring(0, 100)}`);
      }
      state.lastError = new Date().toISOString();
      saveState(state);
    }
  } finally {
    await destroyDiscord();
    console.log('[Main] Exiting.');
    process.exit(process.exitCode || 0);
  }
}

process.on('unhandledRejection', (err) => console.error('[Main] Unhandled rejection:', err));
process.on('uncaughtException', (err) => console.error('[Main] Uncaught exception:', err));

main();
