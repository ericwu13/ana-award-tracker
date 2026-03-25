require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { runParallel } = require('./session');
const { initDiscord, destroyDiscord, notifyAvailability, sendAlert, sendStatusUpdate } = require('./notifier');

const { ANA_USERNAME, ANA_PASSWORD } = process.env;
const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS || '4');
const SKIP_MIXED_CABIN = process.env.SKIP_MIXED_CABIN !== 'false'; // default: skip
const MAX_LAYOVER_HOURS = parseInt(process.env.MAX_LAYOVER_HOURS || '30');
const ALERT_WAITLIST = process.env.ALERT_WAITLIST !== 'false'; // default: alert waitlist too

if (!ANA_USERNAME || !ANA_PASSWORD) {
  console.error('ERROR: ANA_USERNAME and ANA_PASSWORD are required in .env');
  process.exit(1);
}

const { loadRoutes } = require('./routes');

const STATE_FILE = path.join(__dirname, '..', 'data', 'state.json');
const ROUTES = loadRoutes();
const ALL_CABINS = [
  { code: 'CFF1', name: 'Economy' },
  { code: 'CFF2', name: 'Business' },
];

function getCabinsForRoute(route) {
  if (route.cabin === 'economy') return [ALL_CABINS[0]];
  if (route.cabin === 'business') return [ALL_CABINS[1]];
  return ALL_CABINS; // 'both' or undefined
}

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
        console.log(`[Main] 🎉 NEW ${currentStatus}: ${route} ${date} ${result.flightNumber || result.cabin} ${result.routeDesc || ''}`);
        const sent = notifyAvailability(date, result, route);
        if (sent) alertsSent++;
        state.flights[key] = {
          firstSeen: new Date().toISOString(),
          lastSeen: new Date().toISOString(),
          status: currentStatus,
          route,
          date,
          flightNumber: result.flightNumber,
          routeDesc: result.routeDesc,
          cabinDesc: result.cabinDesc,
          duration: result.duration,
        };
      } else if (prev.status === 'waitlist' && currentStatus === 'confirmed') {
        // UPGRADE — was waitlisted, now confirmed! Alert!
        console.log(`[Main] 🎉 UPGRADE: ${route} ${date} ${result.flightNumber} waitlist → confirmed!`);
        const sent = notifyAvailability(date, { ...result, _statusChange: 'UPGRADED from waitlist' }, route);
        if (sent) alertsSent++;
        prev.status = 'confirmed';
        prev.lastSeen = new Date().toISOString();
      } else if (prev.status === 'confirmed' && currentStatus === 'waitlist') {
        // DOWNGRADE — was confirmed, now waitlist only
        console.log(`[Main] ⚠️ DOWNGRADE: ${route} ${date} ${result.flightNumber} confirmed → waitlist`);
        prev.status = 'waitlist';
        prev.lastSeen = new Date().toISOString();
        // Don't alert downgrades — too noisy
      } else {
        // STILL AVAILABLE — same status, don't alert
        prev.lastSeen = new Date().toISOString();
      }
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
    console.log(`[Main] Route: ${route.from}→${route.to} on ${route.dates.join(', ')}`);
  }

  const state = loadState();

  try {
    // Build search jobs: each route × its cabin classes
    const jobs = [];
    for (const route of ROUTES) {
      const cabins = getCabinsForRoute(route);
      for (const cabin of cabins) {
        jobs.push({
          from: route.from,
          to: route.to,
          dates: route.dates,
          cabinCode: cabin.code,
          cabinName: cabin.name,
        });
      }
    }

    // Check if session is known to be stale — don't waste time searching
    const { isStale, getStaleInfo } = require('./session-stale');
    if (isStale()) {
      const info = getStaleInfo();
      console.log(`[Main] Session is stale: ${info?.reason}. Skipping search.`);
      await sendStatusUpdate(`⏸️ Search skipped — session stale: ${info?.reason}\nLog in to ANA in Chrome to resume.`);
      return;
    }

    // Refresh cookies right before searching — ensures they're fresh
    console.log('[Main] Refreshing session before search...');
    const { refreshSession } = require('./session-keepalive');
    await refreshSession();

    // Check again after refresh attempt
    if (isStale()) {
      console.log('[Main] Session went stale during refresh. Skipping search.');
      return;
    }

    // Run all searches in parallel
    const startTime = Date.now();
    const allResults = await runParallel(jobs, MAX_SESSIONS);
    const elapsed = Math.round((Date.now() - startTime) / 1000);

    // Check for session failures (cookie/login issues)
    const sessionFailures = allResults.filter(r => r._sessionFailed);
    if (sessionFailures.length > 0) {
      const failCount = sessionFailures.length;
      const reasons = [...new Set(sessionFailures.map(f => f.error))].join(', ');
      console.error(`[Main] ⚠️ ${failCount} session(s) failed: ${reasons}`);
      await sendAlert(`⚠️ ${failCount} search session(s) failed: ${reasons}\nCookies may have expired — visit ANA in Chrome to refresh.`);
    }

    const validResults = allResults.filter(r => !r._sessionFailed);
    const alertsSent = processResults(validResults, state);
    state.lastCheck = new Date().toISOString();
    saveState(state);

    // Summary
    const tracked = Object.keys(state.flights).length;
    const confirmed = Object.values(state.flights).filter(f => f.status === 'confirmed').length;
    const waitlisted = Object.values(state.flights).filter(f => f.status === 'waitlist').length;

    console.log(`\n[Main] Check complete in ${elapsed}s. ${alertsSent} new alert(s). Tracking ${tracked} flights (${confirmed} confirmed, ${waitlisted} waitlist).`);

    const now = new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit', hour12: true });
    const statusMsg = alertsSent > 0
      ? `✅ ANA check @ ${now} — ${alertsSent} new alert(s)! Tracking ${tracked} flights.`
      : `🔍 ANA check @ ${now} — no changes. Tracking ${tracked} flights (${confirmed} confirmed, ${waitlisted} waitlist).`;
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
