/**
 * seats.aero tracking logic — pure functions, no I/O (unit-tested in
 * test/seats-watch.test.js). run-seats.js wires these to the API, the state
 * file and Discord.
 *
 * Model
 *   - One cached-search query per tracked route (all programs, all cabins,
 *     earliest→latest tracked date). Rows are filtered back to the exact
 *     (date, cabin) pairs the route tracks, and to route.programs if set.
 *   - "Saver" filter: per program+route+cabin we keep the lowest price seen
 *     each day for 30 days. A seat alerts only if
 *        miles <= floor × (1 + SAVER_MARGIN)          (floor = 30-day low)
 *     and, while fewer than LEARN_DAYS days are recorded, also <= the cabin
 *     cap. After that a hard ceiling (cap × HARD_CAP_MULT) still applies so a
 *     dynamic-pricing program whose *floor* is expensive never alerts.
 *     route.maxMiles[cabin], when set, replaces all of this for that cabin.
 *   - Dedup: a key alerts once; it re-alerts only on a lower price. Keys
 *     missing from a successfully scanned route for GRACE consecutive scans
 *     are dropped (same oscillation guard as ANA's GONE_GRACE_MISSES).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULTS = {
  caps: { 'economy': 40000, 'premium-economy': 60000, 'business': 85000, 'first': 110000 },
  saverMargin: 0.10,
  learnDays: 7,
  historyDays: 30,
  hardCapMult: 1.5,
  grace: 3,
};

function utcDay(ms) { return new Date(ms).toISOString().slice(0, 10); }

function routeLabel(from, to) { return `${from}→${to}`; }
function priceKey(e) { return `${e.program}|${routeLabel(e.from, e.to)}|${e.cabinKey}`; }
function entryKey(e) { return `${e.program}|${routeLabel(e.from, e.to)}|${e.date}|${e.cabinKey}`; }
function groupKey(e) { return `${routeLabel(e.from, e.to)}|${e.date}|${e.cabinKey}`; }

/**
 * Routes → queries. Only routes that use seats.aero and have a date on or
 * after `minDate`. wanted: { date: Set(cabinKey) }.
 */
function buildQueries(routes, { usesSource, minDate = '0000-00-00' } = {}) {
  const queries = [];
  for (const route of routes || []) {
    if (usesSource && !usesSource(route, 'seats.aero')) continue;
    const wanted = {};
    for (const [date, cabins] of Object.entries(route.dates || {})) {
      if (date < minDate || !Array.isArray(cabins) || cabins.length === 0) continue;
      wanted[date] = new Set(cabins);
    }
    const dates = Object.keys(wanted).sort();
    if (dates.length === 0) continue;
    queries.push({
      route: routeLabel(route.from, route.to),
      origins: [route.from],
      destinations: [route.to],
      startDate: dates[0],
      endDate: dates[dates.length - 1],
      programs: Array.isArray(route.programs) ? route.programs : [],
      directOnly: route.directOnly === true,
      maxMiles: route.maxMiles || {},
      wanted,
    });
  }
  return queries;
}

/** Keep only entries for the query's tracked (date, cabin) pairs and programs. */
function filterEntries(entries, q) {
  return entries.filter(e =>
    routeLabel(e.from, e.to) === q.route &&
    q.wanted[e.date] && q.wanted[e.date].has(e.cabinKey) &&
    (q.programs.length === 0 || q.programs.includes(e.program)) &&
    (!q.directOnly || e.direct !== false));
}

/**
 * Should this cycle run? Spreads the daily call budget across the day:
 * effective interval = max(intervalMin, 1440 × callsPerCycle / budget).
 */
function planRun({ now, lastRunAt, intervalMin, budget, usage, estCalls }) {
  const today = utcDay(now);
  const used = usage && usage.day === today ? usage.calls : 0;
  const perCycle = Math.max(1, estCalls || 1);
  const effectiveIntervalMin = Math.max(intervalMin, Math.ceil((1440 * perCycle) / Math.max(1, budget)));
  if (lastRunAt) {
    const ageMin = (now - Date.parse(lastRunAt)) / 60000;
    // 2 min slack so a Task Scheduler tick a little early still runs
    if (ageMin >= 0 && ageMin < effectiveIntervalMin - 2) {
      return { run: false, reason: `last scan ${Math.round(ageMin)} min ago (interval ${effectiveIntervalMin} min)`, effectiveIntervalMin, used };
    }
  }
  if (used + perCycle > budget) {
    return { run: false, reason: `daily budget reached (${used}/${budget} calls today)`, effectiveIntervalMin, used };
  }
  return { run: true, reason: null, effectiveIntervalMin, used };
}

function recordUsage(usage, now, calls) {
  const today = utcDay(now);
  if (!usage || usage.day !== today) return { day: today, calls };
  return { day: today, calls: usage.calls + calls };
}

/** Add today's lowest price per priceKey to history and drop days older than historyDays. Mutates + returns history. */
function updateHistory(history, entries, now, historyDays = DEFAULTS.historyDays) {
  const today = utcDay(now);
  const cutoff = utcDay(now - historyDays * DAY_MS);
  for (const e of entries) {
    const k = priceKey(e);
    if (!history[k]) history[k] = {};
    const cur = history[k][today];
    if (cur == null || e.miles < cur) history[k][today] = e.miles;
  }
  for (const k of Object.keys(history)) {
    for (const d of Object.keys(history[k])) if (d < cutoff) delete history[k][d];
    if (Object.keys(history[k]).length === 0) delete history[k];
  }
  return history;
}

/** Price ceiling for an entry. Returns { limit, rule }. */
function saverLimit(e, history, { maxMiles = {}, cfg = DEFAULTS } = {}) {
  if (Number.isFinite(maxMiles[e.cabinKey]) && maxMiles[e.cabinKey] > 0) {
    return { limit: maxMiles[e.cabinKey], rule: 'max-miles' };
  }
  const cap = cfg.caps[e.cabinKey] || Infinity;
  const days = history[priceKey(e)] || {};
  const values = Object.values(days);
  const floor = values.length ? Math.min(...values) : e.miles;
  const saver = Math.floor(floor * (1 + cfg.saverMargin));
  if (values.length < cfg.learnDays) return { limit: Math.min(saver, cap), rule: 'learning' };
  return { limit: Math.min(saver, Math.round(cap * cfg.hardCapMult)), rule: 'saver' };
}

/**
 * Merge one route's scan into state.entries and decide alerts.
 *   scanned: entries (already filterEntries'd) from a SUCCESSFUL query
 * Returns { alerts: [{ entry, reason, limit, rule }], removed: [key] }.
 * Mutates `entries` (state.entries) and reads `history`.
 */
function applyScan(stateEntries, scanned, q, history, { now, cfg = DEFAULTS } = {}) {
  const nowIso = new Date(now).toISOString();
  const alerts = [];
  const present = new Set();
  for (const e of scanned) {
    const k = entryKey(e);
    present.add(k);
    const prev = stateEntries[k];
    const { limit, rule } = saverLimit(e, history, { maxMiles: q.maxMiles, cfg });
    const qualifies = e.miles <= limit;
    const rec = {
      program: e.program, route: q.route, date: e.date, cabinKey: e.cabinKey,
      miles: e.miles, seats: e.seats, airlines: e.airlines, direct: e.direct,
      taxes: e.taxes, taxesCurrency: e.taxesCurrency,
      firstSeen: prev ? prev.firstSeen : nowIso, lastSeen: nowIso, misses: 0,
      alertedMiles: prev ? prev.alertedMiles ?? null : null,
      qualifies,
    };
    if (qualifies && (rec.alertedMiles == null || e.miles < rec.alertedMiles)) {
      alerts.push({ entry: e, reason: rec.alertedMiles == null ? 'new' : 'price-drop', previousMiles: rec.alertedMiles, limit, rule });
      rec.alertedMiles = e.miles;
    }
    stateEntries[k] = rec;
  }
  const removed = [];
  for (const [k, rec] of Object.entries(stateEntries)) {
    if (rec.route !== q.route || present.has(k)) continue;
    // Only judge keys this query could have returned
    if (!q.wanted[rec.date] || !q.wanted[rec.date].has(rec.cabinKey)) continue;
    if (q.programs.length && !q.programs.includes(rec.program)) continue;
    rec.misses = (rec.misses || 0) + 1;
    if (rec.misses >= cfg.grace) { delete stateEntries[k]; removed.push(k); }
  }
  return { alerts, removed };
}

/** Drop entries whose route/date/cabin is no longer tracked by seats.aero. */
function pruneUntracked(stateEntries, queries) {
  const byRoute = new Map(queries.map(q => [q.route, q]));
  let n = 0;
  for (const [k, rec] of Object.entries(stateEntries)) {
    const q = byRoute.get(rec.route);
    if (!q || !q.wanted[rec.date] || !q.wanted[rec.date].has(rec.cabinKey)) { delete stateEntries[k]; n++; }
  }
  return n;
}

/** Group alerts so one Discord message covers every program for a route+date+cabin. */
function groupAlerts(alerts) {
  const groups = new Map();
  for (const a of alerts) {
    const k = groupKey(a.entry);
    if (!groups.has(k)) groups.set(k, { route: routeLabel(a.entry.from, a.entry.to), date: a.entry.date, cabinKey: a.entry.cabinKey, items: [] });
    groups.get(k).items.push(a);
  }
  for (const g of groups.values()) g.items.sort((x, y) => x.entry.miles - y.entry.miles);
  return [...groups.values()].sort((a, b) => a.date.localeCompare(b.date) || a.route.localeCompare(b.route));
}

/** Read tunables from env, falling back to DEFAULTS. */
function configFromEnv(env = process.env) {
  const num = (v, d) => { const n = Number(v); return v != null && String(v).trim() !== '' && Number.isFinite(n) && n >= 0 ? n : d; };
  const caps = { ...DEFAULTS.caps };
  for (const [k, envName] of [['economy', 'Y'], ['premium-economy', 'W'], ['business', 'J'], ['first', 'F']]) {
    caps[k] = num(env[`SEATS_AERO_CAP_${envName}`], caps[k]);
  }
  return {
    caps,
    saverMargin: num(env.SEATS_AERO_SAVER_MARGIN, DEFAULTS.saverMargin),
    learnDays: num(env.SEATS_AERO_LEARN_DAYS, DEFAULTS.learnDays),
    historyDays: num(env.SEATS_AERO_HISTORY_DAYS, DEFAULTS.historyDays),
    hardCapMult: num(env.SEATS_AERO_HARD_CAP_MULT, DEFAULTS.hardCapMult),
    grace: Math.max(1, num(env.SEATS_AERO_GRACE_MISSES, DEFAULTS.grace)),
    intervalMin: num(env.SEATS_AERO_INTERVAL_MIN, 30),
    budget: num(env.SEATS_AERO_DAILY_BUDGET, 900),
  };
}

module.exports = {
  DEFAULTS, utcDay, priceKey, entryKey, groupKey,
  buildQueries, filterEntries, planRun, recordUsage,
  updateHistory, saverLimit, applyScan, pruneUntracked, groupAlerts, configFromEnv,
};
