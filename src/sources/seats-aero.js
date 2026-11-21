/**
 * seats.aero Partner API client (cached search).
 *
 * Documented (developers.seats.aero, skill.md v1.1.0):
 *   GET https://seats.aero/partnerapi/search
 *   header  Partner-Authorization: <key>
 *   params  origin_airport, destination_airport (comma lists), start_date,
 *           end_date (YYYY-MM-DD), take (10..1000), sources (comma list),
 *           only_direct_flights, cursor, skip
 *   paging  response has hasMore / moreURL / cursor; follow
 *           https://seats.aero{moreURL} until hasMore is false; dedupe by ID
 *   row     ID, Date, Source, Route{OriginAirport,DestinationAirport},
 *           {Y,W,J,F}Available, {..}MileageCost (string in examples),
 *           {..}RemainingSeats, {..}Airlines ("AC,LH" or "AA, AS"), {..}Direct
 *
 * NOT documented — read defensively, verify with scripts/seats-aero-sample.js:
 *   - the array key holding rows (`data` assumed; a bare array also accepted)
 *   - taxes ({..}TotalTaxes, TaxesCurrency) and freshness (UpdatedAt /
 *     ComputedLastSeen)
 * All field access lives in rowToEntries() so a rename touches one function.
 */

const BASE = process.env.SEATS_AERO_BASE_URL || 'https://seats.aero';
const SEARCH_PATH = '/partnerapi/search';

// seats.aero field prefix per routes.json cabin key
const CABIN_PREFIX = {
  'economy': 'Y',
  'premium-economy': 'W',
  'business': 'J',
  'first': 'F',
};

class SeatsAeroError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

function apiKey(env = process.env) { return (env.SEATS_AERO_API_KEY || '').trim(); }

function parseAirlines(v) {
  return String(v || '').split(/[,\s]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
}

function toInt(v) {
  if (v == null || v === '') return null;
  const n = parseInt(String(v).replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Pure: one availability row → one entry per available cabin.
 * entry = { id, program, from, to, date, cabinKey, miles, seats, airlines,
 *           direct, taxes, taxesCurrency, updatedAt }
 */
function rowToEntries(row) {
  if (!row || typeof row !== 'object') return [];
  const from = (row.Route && row.Route.OriginAirport) || row.OriginAirport;
  const to = (row.Route && row.Route.DestinationAirport) || row.DestinationAirport;
  const date = String(row.Date || '').slice(0, 10);
  const program = String(row.Source || (row.Route && row.Route.Source) || 'unknown').toLowerCase();
  if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];

  const out = [];
  for (const [cabinKey, p] of Object.entries(CABIN_PREFIX)) {
    if (row[`${p}Available`] !== true) continue;
    const miles = toInt(row[`${p}MileageCost`]);
    if (!miles) continue; // available with no price is useless for a saver filter
    const taxesRaw = row[`${p}TotalTaxes`];
    out.push({
      id: row.ID || null,
      program,
      from: String(from).toUpperCase(),
      to: String(to).toUpperCase(),
      date,
      cabinKey,
      miles,
      seats: Number.isFinite(row[`${p}RemainingSeats`]) && row[`${p}RemainingSeats`] > 0 ? row[`${p}RemainingSeats`] : null,
      airlines: parseAirlines(row[`${p}Airlines`]),
      direct: typeof row[`${p}Direct`] === 'boolean' ? row[`${p}Direct`] : null,
      taxes: Number.isFinite(taxesRaw) ? taxesRaw : null,
      taxesCurrency: row.TaxesCurrency || null,
      updatedAt: row.UpdatedAt || row.ComputedLastSeen || null,
    });
  }
  return out;
}

function rowsOf(body) {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.data)) return body.data;
  return [];
}

/**
 * One cached search, following pagination. Returns { rows, calls }.
 * `calls` counts HTTP requests so the caller can charge the daily budget.
 * Throws SeatsAeroError on HTTP errors (status attached).
 */
async function searchWindow(q, { env = process.env, fetchImpl = globalThis.fetch, maxPages = 10, timeoutMs = 20000 } = {}) {
  const qs = new URLSearchParams({
    origin_airport: q.origins.join(','),
    destination_airport: q.destinations.join(','),
    start_date: q.startDate,
    end_date: q.endDate,
    take: '1000',
  });
  if (q.programs && q.programs.length) qs.set('sources', q.programs.join(','));
  if (q.directOnly) qs.set('only_direct_flights', 'true');

  const seen = new Set();
  const rows = [];
  let url = `${BASE}${SEARCH_PATH}?${qs}`;
  let calls = 0;
  for (let page = 0; page < maxPages && url; page++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      calls++;
      res = await fetchImpl(url, {
        headers: { 'Partner-Authorization': apiKey(env), accept: 'application/json' },
        signal: ctrl.signal,
      });
    } finally { clearTimeout(timer); }
    if (!res.ok) throw new SeatsAeroError(`seats.aero HTTP ${res.status}`, res.status);
    const body = await res.json();
    for (const row of rowsOf(body)) {
      const id = row && row.ID;
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      rows.push(row);
    }
    const more = body && body.hasMore && body.moreURL;
    const next = more ? (String(body.moreURL).startsWith('http') ? body.moreURL : `${BASE}${body.moreURL}`) : null;
    url = next && next !== url ? next : null;
  }
  return { rows, calls };
}

module.exports = { CABIN_PREFIX, SeatsAeroError, apiKey, rowToEntries, rowsOf, searchWindow, parseAirlines };
