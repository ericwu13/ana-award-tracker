/**
 * One seats.aero scan cycle. Independent of the ANA scraper: no browser, no
 * cookies, no session-stale flag, its own state file (data/seats-state.json,
 * written only here, atomically). Entry point: run-seats.js.
 *
 * Every dependency is injectable so test/seats-run.test.js can drive a full
 * cycle with a fake fetch and an in-memory state.
 */
const fs = require('fs');
const path = require('path');
const watch = require('./seats-watch');
const api = require('./sources/seats-aero');

const STATE_FILE = path.join(__dirname, '..', 'data', 'seats-state.json');
const AUTH_ALERT_EVERY_MS = 6 * 60 * 60 * 1000;

function emptyState() {
  return { lastRunAt: null, usage: null, lastCallsPerCycle: null, entries: {}, history: {}, lastResult: null, authAlertAt: null };
}

function loadSeatsState(file = STATE_FILE) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (_) { return emptyState(); }
  // A corrupt file must not silently reset dedup (that would re-alert every
  // seat). Throw so the cycle stops and the error is visible.
  const s = JSON.parse(raw);
  return { ...emptyState(), ...s, entries: s.entries || {}, history: s.history || {} };
}

function saveSeatsState(state, file = STATE_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

/**
 * @returns {Promise<{ skipped?: string, alerts?: number, errors?: string[] }>}
 */
async function runSeatsCycle({
  env = process.env,
  now = Date.now(),
  force = false,
  routes,
  usesSource,
  minDate,
  state,
  saveState = () => {},
  fetchImpl = globalThis.fetch,
  notify = async () => true,
  sendAlert = async () => true,
  log = () => {},
} = {}) {
  if (!api.apiKey(env)) return { skipped: 'SEATS_AERO_API_KEY not set' };
  const cfg = watch.configFromEnv(env);
  const queries = watch.buildQueries(routes, { usesSource, minDate });
  if (queries.length === 0) return { skipped: 'no routes tracked with seats.aero' };

  const plan = watch.planRun({
    now, lastRunAt: force ? null : state.lastRunAt, intervalMin: cfg.intervalMin,
    budget: cfg.budget, usage: state.usage, estCalls: state.lastCallsPerCycle || queries.length,
  });
  if (!plan.run) return { skipped: plan.reason };

  const pruned = watch.pruneUntracked(state.entries, queries);
  if (pruned) log(`Pruned ${pruned} entr${pruned === 1 ? 'y' : 'ies'} no longer tracked`);

  let calls = 0, rowsTotal = 0, alertsSent = 0, authError = null;
  const errors = [];
  for (const q of queries) {
    let scanned;
    try {
      const { rows, calls: c } = await api.searchWindow(q, { env, fetchImpl });
      calls += c;
      rowsTotal += rows.length;
      scanned = watch.filterEntries(rows.flatMap(api.rowToEntries), q);
    } catch (e) {
      calls += 1;
      errors.push(`${q.route}: ${e.message}`);
      if (e.status === 401 || e.status === 403) { authError = e; break; }
      continue; // failed route: no GONE judgement this cycle
    }
    watch.updateHistory(state.history, scanned, now, cfg.historyDays);
    const { alerts, removed } = watch.applyScan(state.entries, scanned, q, state.history, { now, cfg });
    log(`${q.route} ${q.startDate}..${q.endDate}: ${scanned.length} tracked seat(s), ${alerts.length} alert(s)${removed.length ? `, ${removed.length} gone` : ''}`);
    for (const group of watch.groupAlerts(alerts)) {
      if (await notify(group)) alertsSent++;
    }
  }

  state.lastRunAt = new Date(now).toISOString();
  state.usage = watch.recordUsage(state.usage, now, calls);
  if (!authError) state.lastCallsPerCycle = calls;
  state.lastResult = {
    at: state.lastRunAt, routes: queries.length, calls, rows: rowsTotal, alerts: alertsSent,
    errors: errors.slice(0, 10), intervalMin: plan.effectiveIntervalMin,
  };

  if (authError && (!state.authAlertAt || now - Date.parse(state.authAlertAt) > AUTH_ALERT_EVERY_MS)) {
    await sendAlert(`⚠️ seats.aero rejected the API key (HTTP ${authError.status}). seats.aero tracking is paused until SEATS_AERO_API_KEY is fixed. ANA tracking is unaffected.`);
    state.authAlertAt = new Date(now).toISOString();
  }
  saveState(state);
  return { alerts: alertsSent, errors, calls };
}

module.exports = { runSeatsCycle, loadSeatsState, saveSeatsState, emptyState, STATE_FILE };
