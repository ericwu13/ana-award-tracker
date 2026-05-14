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
const SKIP_KNOWN_AVAILABLE = process.env.SKIP_KNOWN_AVAILABLE === 'true'; // default: OFF — always re-check so GONE detection works; set =true to reduce ANA load at cost of delayed GONE detection
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
 * Process a single search result entry: filter, dedup against state.flights,
 * and send Discord notifications for NEW or UPGRADED flights IMMEDIATELY.
 *
 * Called via the `onResult` callback from inside runParallel's worker loop,
 * so each notification fires within seconds of the bot finding the flight —
 * not after the full 5-15 minute batch completes. This matters for volatile
 * partner award seats (EVA, United) that can appear and vanish in minutes.
 *
 * Returns { alertsSent, seenKeys } so the caller can accumulate totals for
 * the end-of-batch summary and GONE detection.
 */
async function processOneResult({ route, cabin, date, results }, state) {
  const seenKeys = [];
  let alertsSent = 0;

  if (!state.flights) state.flights = {};
  if (!results || results.length === 0 || results[0]?.noResults) {
    return { alertsSent, seenKeys };
  }

  for (const result of results) {
    if (!result.available && !result.waitlist) continue;

    // --- FILTERS ---
    if (SKIP_MIXED_CABIN && result.isMixedCabin) {
      console.log(`[Main] Skipped mixed cabin: ${route} ${date} ${result.flightNumber} (${result.cabinDesc})`);
      continue;
    }
    const hours = durationToHours(result.duration);
    if (hours > MAX_LAYOVER_HOURS && result.layover) {
      console.log(`[Main] Skipped long layover: ${route} ${date} ${result.flightNumber} (${result.duration})`);
      continue;
    }
    if (!ALERT_WAITLIST && result.waitlist) continue;

    // --- DEDUPLICATION & STATUS TRACKING ---
    const key = flightKey(route, date, result);
    seenKeys.push(key);
    const currentStatus = result.waitlist ? 'waitlist' : 'confirmed';
    const prev = state.flights[key];

    if (!prev) {
      // NEW flight — alert immediately!
      console.log(`[Main] 🎉 NEW ${currentStatus}: ${route} ${date} ${result.flightNumber || result.cabin} ${result.routeDesc || ''}${result.miles ? ` (${result.miles.toLocaleString()} miles)` : ''}`);
      const sent = await notifyAvailability(date, result, route);
      if (sent) alertsSent++;
      state.flights[key] = {
        firstSeen: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        status: currentStatus,
        route,
        date,
        searchedCabin: cabin,
        flightNumber: result.flightNumber,
        routeDesc: result.routeDesc,
        cabinDesc: result.cabinDesc,
        duration: result.duration,
        miles: result.miles ?? null,
      };
    } else if (prev.status === 'waitlist' && currentStatus === 'confirmed') {
      // UPGRADE — alert only if not flip-flopping (cooldown: 6h).
      // ANA's yield system can toggle availability between searches, causing
      // waitlist→confirmed→waitlist→confirmed oscillations on each 60-min cycle.
      // Without dampening, every upswing triggers a redundant UPGRADE alert.
      const UPGRADE_COOLDOWN_MS = 6 * 60 * 60 * 1000;
      const lastAlert = prev.lastUpgradeAlert ? new Date(prev.lastUpgradeAlert).getTime() : 0;
      const now = Date.now();

      if (now - lastAlert > UPGRADE_COOLDOWN_MS) {
        console.log(`[Main] 🎉 UPGRADE: ${route} ${date} ${result.flightNumber} waitlist → confirmed!`);
        const sent = await notifyAvailability(date, { ...result, _statusChange: 'UPGRADED from waitlist' }, route);
        if (sent) alertsSent++;
        prev.lastUpgradeAlert = new Date(now).toISOString();
      } else {
        const agoMin = Math.round((now - lastAlert) / 60000);
        console.log(`[Main] ⏳ Suppressed flip-flop: ${route} ${date} ${result.flightNumber} waitlist → confirmed (last alert ${agoMin}min ago)`);
      }
      prev.status = 'confirmed';
      prev.lastSeen = new Date().toISOString();
      if (result.miles != null) prev.miles = result.miles;
    } else if (prev.status === 'confirmed' && currentStatus === 'waitlist') {
      // DOWNGRADE — log only, don't alert (too noisy)
      console.log(`[Main] ⚠️ DOWNGRADE: ${route} ${date} ${result.flightNumber} confirmed → waitlist`);
      prev.status = 'waitlist';
      prev.lastSeen = new Date().toISOString();
      if (result.miles != null) prev.miles = result.miles;
    } else {
      // STILL AVAILABLE — update lastSeen, detect miles changes
      prev.lastSeen = new Date().toISOString();
      if (result.miles != null && prev.miles != null && result.miles !== prev.miles) {
        const delta = result.miles - prev.miles;
        const sign = delta > 0 ? '+' : '';
        console.log(`[Main] 💰 MILES CHANGED: ${route} ${date} ${result.flightNumber}: ${prev.miles.toLocaleString()} → ${result.miles.toLocaleString()} (${sign}${delta.toLocaleString()})`);
      }
      if (result.miles != null) prev.miles = result.miles;
    }
  }

  return { alertsSent, seenKeys };
}

/**
 * GONE detection — runs AFTER all searches complete (cannot be streamed).
 *
 * When a (route, date, cabin) combo was searched AND a previously-confirmed
 * flight is no longer in the results, alert the user and remove from state.
 *
 * @param {Array} allResults — full results array from runParallel
 * @param {Object} state — in-memory state (mutated: flights may be deleted)
 * @param {Set} seenKeys — flight keys seen during this run (accumulated via onResult)
 */
async function detectGoneFlights(allResults, state, seenKeys) {
  const searchedRouteDateCabin = new Set();
  for (const { route, cabin, date, results } of allResults) {
    if (results && results.length > 0 && !results[0]?._sessionFailed) {
      searchedRouteDateCabin.add(`${route}|${date}|${cabin}`);
    }
  }

  for (const [key, flight] of Object.entries(state.flights)) {
    if (!flight.searchedCabin) continue;
    const combo = `${flight.route}|${flight.date}|${flight.searchedCabin}`;
    if (searchedRouteDateCabin.has(combo) && !seenKeys.has(key)) {
      if (flight.status === 'confirmed') {
        console.log(`[Main] ❌ GONE: ${flight.route} ${flight.date} ${flight.flightNumber} was confirmed, now unavailable`);
        const milesLine = flight.miles ? `\nWas: ${flight.miles.toLocaleString()} miles` : '';
        await sendAlert(`❌ **Seats gone**: ${flight.flightNumber} ${flight.route} ${flight.date}\n${flight.cabinDesc || ''} — no longer available${milesLine}`);
      }
      delete state.flights[key];
    }
  }
}

async function main() {
  // Initialize Discord bot
  await initDiscord();

  console.log(`\n[Main] === Run started ${new Date().toISOString()} (PID ${process.pid}) ===`);
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

    // Skip-known-confirmed: skip re-searching combos that already have confirmed
    // flights in state (within RECHECK_HOURS). Reduces ANA requests at the cost
    // of delayed GONE detection (~RECHECK_HOURS + 1 cycle). Safe to enable now
    // that alert-level flip-flop dampening (lastUpgradeAlert cooldown) prevents
    // redundant UPGRADE notifications when ANA's yield system toggles availability.
    // Set SKIP_KNOWN_AVAILABLE=false in .env to re-search every cycle if GONE
    // detection latency matters more than request volume.
    const skipCombos = new Set();
    let skippedDueToConfirmed = 0;
    if (SKIP_KNOWN_AVAILABLE && state.flights) {
      const recheckMs = RECHECK_HOURS * 60 * 60 * 1000;
      const now = Date.now();
      for (const flight of Object.values(state.flights)) {
        if (flight.status !== 'confirmed') continue;
        if (!flight.searchedCabin) continue;
        const lastSeen = new Date(flight.lastSeen).getTime();
        if (now - lastSeen > recheckMs) continue;
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

    // Run all searches in parallel. The onResult callback fires for each
    // successful search so Discord notifications go out IMMEDIATELY — within
    // seconds of discovery, not after the full 5-15 minute batch completes.
    const startTime = Date.now();
    if (!state.lastChecked) state.lastChecked = {};

    let alertsSent = 0;
    const allSeenKeys = new Set();

    const onResult = async (entry) => {
      const { alertsSent: a, seenKeys } = await processOneResult(entry, state);
      alertsSent += a;
      for (const k of seenKeys) allSeenKeys.add(k);
    };

    const allResults = await runParallel(jobs, MAX_SESSIONS, state.lastChecked, onResult);
    const elapsed = Math.round((Date.now() - startTime) / 1000);

    // Mark each task that was actually attempted
    let checkedCount = 0;
    let rateLimitedCount = 0;
    let timedOutCount = 0;
    let formErrorCount = 0;
    for (const r of allResults) {
      if (r._sessionFailed) continue;
      const key = `${r.route}|${r.date}|${r.cabin}`;
      if (expectedTasks.has(key)) {
        if (r._rateLimited) {
          expectedTasks.set(key, 'rate-limited');
          rateLimitedCount++;
        } else if (r._timedOut) {
          // Don't stamp lastChecked — keeps this task at the front of the
          // oldest-first priority sort next cycle so it gets retried promptly.
          expectedTasks.set(key, 'timed-out');
          timedOutCount++;
        } else if (r._formError) {
          // Server rejected the form (empty hidden field / "Please select a
          // city or an airport"). Don't stamp lastChecked — retry next cycle.
          expectedTasks.set(key, 'form-error');
          formErrorCount++;
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

    // Categorize session failures. Anything that isn't rate-limited or a CDP
    // protocol timeout falls into the cookie/login bucket — bucketing protocol
    // timeouts separately stops them from misleading the user into re-logging
    // when the actual cause is renderer overload.
    const sessionFailures = allResults.filter(r => r._sessionFailed);
    const rateLimitedSessions = sessionFailures.filter(f => f.rateLimited || f.error === 'RATE_LIMITED');
    const protocolTimeouts = sessionFailures.filter(f =>
      !f.rateLimited && f.error !== 'RATE_LIMITED' &&
      /Runtime\.callFunctionOn timed out|ProtocolError|Target closed/i.test(f.error || '')
    );
    const cookieIssues = sessionFailures.filter(f =>
      !rateLimitedSessions.includes(f) && !protocolTimeouts.includes(f)
    );
    if (sessionFailures.length > 0) {
      console.error(`[Main] ⚠️ ${sessionFailures.length} session(s) failed (${rateLimitedSessions.length} rate-limited, ${protocolTimeouts.length} CDP timeout, ${cookieIssues.length} cookie/login)`);
      if (cookieIssues.length > 0) {
        await sendAlert(`⚠️ ${cookieIssues.length} session(s) failed: ${cookieIssues[0].error}\nLog in to ANA in Chrome to refresh cookies.`);
      }
      if (protocolTimeouts.length > 0) {
        await sendAlert(`⚠️ ${protocolTimeouts.length} session(s) failed: Chrome renderer was unresponsive (CDP timeout). Will retry next cycle. No action needed.`);
      }
    }

    // Save coverage to state for /status (cap skippedKeys to avoid unbounded growth)
    state.lastCoverage = {
      timestamp: new Date().toISOString(),
      total: totalExpected,
      checked: checkedCount,
      rateLimited: rateLimitedCount,
      timedOut: timedOutCount,
      formError: formErrorCount,
      skipped: skippedCount,
      sessionsRateLimited: rateLimitedSessions.length,
      skippedSample: skippedTasks.slice(0, 20),
    };

    // GONE detection — deferred to post-batch because it needs to know
    // which combos were searched AND which flights were NOT found.
    const validResults = allResults.filter(r => !r._sessionFailed);
    await detectGoneFlights(validResults, state, allSeenKeys);

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

    console.log(`\n[Main] Check complete in ${elapsed}s. ${alertsSent} new alert(s). Coverage: ${checkedCount}/${totalExpected} checked, ${rateLimitedCount} rate-limited, ${timedOutCount} timed-out, ${formErrorCount} form-error, ${skippedCount} skipped. Tracking ${tracked} flights.`);

    // Build a readable coverage line for Discord
    let coverageMsg = `${checkedCount}/${totalExpected} checked`;
    if (rateLimitedCount > 0) coverageMsg += `, ${rateLimitedCount} rate-limited`;
    if (timedOutCount > 0) coverageMsg += `, ${timedOutCount} timed-out`;
    if (formErrorCount > 0) coverageMsg += `, ${formErrorCount} form-error`;
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
    console.log(`[Main] === Run finished ${new Date().toISOString()} exitCode=${process.exitCode || 0} ===\n`);
    process.exit(process.exitCode || 0);
  }
}

process.on('unhandledRejection', (err) => console.error('[Main] Unhandled rejection:', err));
process.on('uncaughtException', (err) => console.error('[Main] Uncaught exception:', err));

main();
