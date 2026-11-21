/**
 * seats.aero Partner API scan source.
 *
 * Uses the *cached search* endpoint — seats.aero's own crawl, so it costs us
 * one HTTPS call per (route, cabin, date-window) and never touches ANA.
 *
 * ⚠️ GUESS (verify against https://developers.seats.aero before relying on it):
 *   - endpoint  GET https://seats.aero/partnerapi/search
 *   - auth      header `Partner-Authorization: <key>`
 *   - params    origin_airport, destination_airport, cabin
 *               (economy|premium|business|first), start_date, end_date,
 *               sources (comma list), take, cursor
 *   - response  { data: [row], hasMore, cursor }
 *   - row       { Date:'YYYY-MM-DD', Source:'aeroplan',
 *                 Route:{OriginAirport, DestinationAirport},
 *                 JAvailable, JMileageCost:'75000', JRemainingSeats,
 *                 JAirlines:'NH, UA', JDirect, UpdatedAt, ... }  (Y/W/J/F prefixes)
 * The row → ScanEntry mapping is isolated in rowToEntries() so a field-name
 * fix touches one function (and test/sources.test.js).
 */

const BASE_URL = process.env.SEATS_AERO_BASE_URL || 'https://seats.aero/partnerapi';

// routes.json cabin key → seats.aero cabin param + row field prefix
const CABIN_MAP = {
  'economy':         { param: 'economy',  prefix: 'Y' },
  'premium-economy': { param: 'premium',  prefix: 'W' },
  'business':        { param: 'business', prefix: 'J' },
  'first':           { param: 'first',    prefix: 'F' },
};

// Star Alliance marketing codes — space on these carriers is what the ANA
// site can also sell. Rows only on e.g. EY/EK (Aeroplan partners outside Star)
// are irrelevant to an ANA confirm and are dropped.
const STAR_ALLIANCE = new Set([
  'A3', 'AC', 'AI', 'AV', 'BR', 'CA', 'CM', 'ET', 'LH', 'LO', 'LX', 'MS',
  'NH', 'NZ', 'OS', 'OU', 'OZ', 'SA', 'SK', 'SN', 'SQ', 'TG', 'TK', 'TP', 'UA', 'ZH',
]);

function config() {
  return {
    apiKey: process.env.SEATS_AERO_API_KEY || '',
    // Which seats.aero programs to read. Aeroplan + United see the widest
    // Star Alliance partner inventory. GUESS: good default, tune later.
    sources: (process.env.SEATS_AERO_SOURCES || 'aeroplan,united').split(',').map(s => s.trim()).filter(Boolean),
    airlines: process.env.SEATS_AERO_AIRLINES
      ? new Set(process.env.SEATS_AERO_AIRLINES.split(',').map(s => s.trim().toUpperCase()).filter(Boolean))
      : STAR_ALLIANCE,
    // Ignore rows seats.aero hasn't refreshed in this long — a stale hit would
    // just burn an ANA search.
    maxAgeHours: parseFloat(process.env.SEATS_AERO_MAX_AGE_HOURS || '48'),
    timeoutMs: parseInt(process.env.SEATS_AERO_TIMEOUT_MS || '20000'),
  };
}

function parseAirlines(str) {
  return String(str || '').split(/[,\s]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
}

/**
 * Pure: one seats.aero availability row → ScanEntry for the requested cabin,
 * or null when the row doesn't describe usable space. `now` injectable.
 */
function rowToEntry(row, cabinKey, cfg, now = Date.now()) {
  const cab = CABIN_MAP[cabinKey];
  if (!cab || !row) return null;
  const p = cab.prefix;
  const airlines = parseAirlines(row[`${p}Airlines`]);
  const available = row[`${p}Available`] === true;
  const updatedAt = row.UpdatedAt || row.ComputedLastSeen || null;
  const ageH = updatedAt ? (now - new Date(updatedAt).getTime()) / 3600000 : Infinity;
  const relevantCarrier = airlines.length === 0 || airlines.some(a => cfg.airlines.has(a));
  const miles = parseInt(String(row[`${p}MileageCost`] ?? '').replace(/[^\d]/g, ''), 10);
  return {
    from: row.Route?.OriginAirport,
    to: row.Route?.DestinationAirport,
    date: String(row.Date || '').slice(0, 10),
    cabinKey,
    available: available && relevantCarrier && ageH <= cfg.maxAgeHours,
    source: 'seats.aero',
    program: row.Source || row.Route?.Source || 'unknown',
    miles: Number.isFinite(miles) && miles > 0 ? miles : null,
    seats: row[`${p}RemainingSeats`] ?? null,
    airlines,
    direct: row[`${p}Direct`] ?? null,
    updatedAt,
    stale: ageH > cfg.maxAgeHours,
  };
}

/** Group tasks into one API window per (from, to, cabinKey). Pure. */
function groupTasks(tasks) {
  const groups = new Map();
  for (const t of tasks) {
    if (!CABIN_MAP[t.cabinKey]) continue;
    const k = `${t.from}|${t.to}|${t.cabinKey}`;
    if (!groups.has(k)) groups.set(k, { from: t.from, to: t.to, cabinKey: t.cabinKey, dates: [] });
    groups.get(k).dates.push(t.date);
  }
  for (const g of groups.values()) {
    g.dates.sort();
    g.startDate = g.dates[0];
    g.endDate = g.dates[g.dates.length - 1];
  }
  return [...groups.values()];
}

async function fetchWindow(group, cfg, fetchImpl) {
  const rows = [];
  let cursor = null;
  for (let page = 0; page < 10; page++) { // hard cap: never loop forever on a bad cursor
    const qs = new URLSearchParams({
      origin_airport: group.from,
      destination_airport: group.to,
      cabin: CABIN_MAP[group.cabinKey].param,
      start_date: group.startDate,
      end_date: group.endDate,
      take: '500',
    });
    if (cfg.sources.length) qs.set('sources', cfg.sources.join(','));
    if (cursor) qs.set('cursor', String(cursor));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
    let res;
    try {
      res = await fetchImpl(`${BASE_URL}/search?${qs}`, {
        headers: { 'Partner-Authorization': cfg.apiKey, accept: 'application/json' },
        signal: ctrl.signal,
      });
    } finally { clearTimeout(timer); }
    if (!res.ok) throw new Error(`seats.aero HTTP ${res.status}`);
    const body = await res.json();
    rows.push(...(body.data || []));
    if (!body.hasMore || !body.cursor || body.cursor === cursor) break;
    cursor = body.cursor;
  }
  return rows;
}

/**
 * Scan tasks. Returns { entries, errors, scannedGroups }.
 * `entries` holds one ScanEntry per (row, cabin) for dates we asked about —
 * a date with no row simply has no entry (= "seats.aero saw nothing").
 * A window that errored is listed in `errors` and its tasks get NO entries;
 * the planner treats them as unscanned (→ ANA checks them as before).
 */
async function search(tasks, { fetchImpl = globalThis.fetch, now = Date.now(), log = () => {} } = {}) {
  const cfg = config();
  const entries = [];
  const errors = [];
  const scannedGroups = [];
  for (const group of groupTasks(tasks)) {
    const wanted = new Set(group.dates);
    try {
      const rows = await fetchWindow(group, cfg, fetchImpl);
      for (const row of rows) {
        const e = rowToEntry(row, group.cabinKey, cfg, now);
        if (!e || !wanted.has(e.date)) continue;
        if (e.from !== group.from || e.to !== group.to) continue;
        entries.push(e);
      }
      scannedGroups.push(group);
      log(`seats.aero ${group.from}→${group.to} ${group.cabinKey} ${group.startDate}..${group.endDate}: ${rows.length} row(s), ${entries.filter(e => e.available && e.from === group.from && e.to === group.to && e.cabinKey === group.cabinKey).length} hit(s)`);
    } catch (err) {
      errors.push(`${group.from}→${group.to} ${group.cabinKey}: ${err.message}`);
    }
  }
  return { entries, errors, scannedGroups };
}

module.exports = {
  id: 'seats.aero',
  role: 'scan',
  enabled: () => !!config().apiKey,
  search,
  // exposed for tests
  rowToEntry, groupTasks, config, CABIN_MAP, STAR_ALLIANCE,
};
