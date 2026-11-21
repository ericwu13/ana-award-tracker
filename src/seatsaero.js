/**
 * seats.aero source — queries the seats.aero Partner API (cached search) for
 * the same routes/dates/cabins as routes.json and converts the hits into the
 * same result shape the ANA parser produces, so processOneResult (Discord
 * alerts, dedup, UPGRADE) and detectGoneFlights (GONE grace period) are reused
 * unchanged.
 *
 * Enabled only when SEATS_AERO_API_KEY is set (a seats.aero Pro key, from
 * https://seats.aero/settings). Pure HTTP — no browser, no ANA cookies — so it
 * runs even when the ANA session is stale.
 *
 * Isolation from the ANA search:
 *   - Entries use cabin `seats.aero:<Cabin Name>` (e.g. `seats.aero:Business`),
 *     so their GONE "searched combo" never overlaps an ANA combo. If one source
 *     fails, the other source's flights don't collect misses.
 *   - Results carry `source` (the mileage program, e.g. "aeroplan"); flightKey
 *     in index.js prefixes keys with it, so the same NH7 seen by ANA and by
 *     seats.aero/aeroplan are two separate state entries.
 *
 * Env:
 *   SEATS_AERO_API_KEY   Pro API key (required to enable)
 *   SEATS_AERO_SOURCES   optional comma list of programs, e.g. "aeroplan,united,lifemiles"
 *                        (unset = all programs seats.aero has)
 *   SEATS_AERO_DIRECT_ONLY=true  only nonstop itineraries
 *
 * Fields marked GUESS below come from the OpenAPI example only; units are not
 * documented and should be verified against a live response.
 */

const API_BASE = 'https://seats.aero/partnerapi';
const PAGE_SIZE = 500;
const MAX_PAGES = 10; // safety cap per route (5000 rows)
const SOURCE_TAG = 'seats.aero';

// routes.json cabin key → seats.aero cabin name, availability-field prefix, display name
const CABINS = {
  'economy':         { api: 'economy',  prefix: 'Y', name: 'Economy' },
  'premium-economy': { api: 'premium',  prefix: 'W', name: 'Premium Economy' },
  'business':        { api: 'business', prefix: 'J', name: 'Business' },
  'first':           { api: 'first',    prefix: 'F', name: 'First' },
};

const PROGRAM_NAMES = {
  aeroplan: 'Aeroplan', united: 'United MileagePlus', american: 'AAdvantage',
  alaska: 'Alaska Mileage Plan', delta: 'Delta SkyMiles', lifemiles: 'LifeMiles',
  virginatlantic: 'Virgin Atlantic', flyingblue: 'Flying Blue', emirates: 'Emirates Skywards',
  qantas: 'Qantas', velocity: 'Velocity', etihad: 'Etihad Guest', smiles: 'Smiles',
  turkish: 'Turkish Miles&Smiles', singapore: 'KrisFlyer', connectmiles: 'ConnectMiles',
  eurobonus: 'EuroBonus', qatar: 'Qatar Privilege Club', jetblue: 'JetBlue TrueBlue',
  ethiopian: 'ShebaMiles', saudia: 'Saudia AlFursan', finnair: 'Finnair Plus',
  aeromexico: 'Aeromexico Rewards', azul: 'Azul',
};

function cabinComboName(cabinKey) {
  return `${SOURCE_TAG}:${CABINS[cabinKey].name}`;
}

/** "1133" minutes → "18h53min" (format durationToHours in index.js parses). GUESS: unit = minutes. */
function minutesToDuration(min) {
  const m = Number(min);
  if (!Number.isFinite(m) || m <= 0) return '';
  return `${Math.floor(m / 60)}h${String(Math.round(m % 60)).padStart(2, '0')}min`;
}

/** "2026-05-01T13:52:00Z" → "13:52". GUESS: seats.aero stamps airport-local times with a Z suffix, so we don't timezone-convert. */
function hhmm(iso) {
  return typeof iso === 'string' && iso.length >= 16 ? iso.slice(11, 16) : '';
}

/**
 * GUESS: TotalTaxes is an integer in the currency's minor unit (cents),
 * e.g. 1290 = $12.90. Only USD (or blank currency) is mapped to taxUsd since
 * the notifier prints it with "$".
 */
function taxesToUsd(totalTaxes, currency) {
  if (totalTaxes == null) return null;
  if (currency && currency.toUpperCase() !== 'USD') return null;
  const n = Number(totalTaxes);
  return Number.isFinite(n) ? n / 100 : null;
}

/** Map one AvailabilityTrip → ANA-parser-shaped result. */
function tripToResult(trip, avail, cabinKey) {
  const cabin = CABINS[cabinKey];
  const program = trip.Source || avail.Source || '';
  const flights = String(trip.FlightNumbers || '').split(',').map(s => s.trim()).filter(Boolean);
  const segs = Array.isArray(trip.AvailabilitySegments)
    ? trip.AvailabilitySegments.slice().sort((a, b) => (a.Order ?? 0) - (b.Order ?? 0))
    : [];
  const stops = segs.slice(0, -1).map(s => s.DestinationAirport).filter(Boolean);
  const nStops = Number.isFinite(trip.Stops) ? trip.Stops : stops.length;
  const miles = parseInt(trip.MileageCost, 10);

  return {
    source: program,
    sourceName: PROGRAM_NAMES[program] || program,
    available: true,
    waitlist: false,
    confirmed: true,
    cabin: cabin.name,
    symbol: '○',
    flightNumber: flights.join('+') || (trip.Carriers || '').replace(/\s/g, ''),
    depTime: hhmm(trip.DepartsAt),
    arrTime: hhmm(trip.ArrivesAt),
    duration: minutesToDuration(trip.TotalDuration),
    stops,
    layover: nStops > 0,
    isMixedCabin: trip.MixedCabinPct != null && trip.MixedCabinPct < 100,
    cabinDesc: `${cabin.name} via ${PROGRAM_NAMES[program] || program}`,
    routeDesc: [avail.Route?.OriginAirport, ...stops, avail.Route?.DestinationAirport].filter(Boolean).join('-'),
    miles: Number.isFinite(miles) && miles > 0 ? miles : null,
    taxUsd: taxesToUsd(trip.TotalTaxes, trip.TaxesCurrency),
    remainingSeats: trip.RemainingSeats ?? null,
    format: 'seats.aero',
  };
}

/** Fallback when an availability row says the cabin is open but has no trips attached. */
function summaryToResult(avail, cabinKey) {
  const cabin = CABINS[cabinKey];
  const p = cabin.prefix;
  const program = avail.Source || avail.Route?.Source || '';
  const miles = parseInt(avail[`${p}MileageCost`], 10);
  const airlines = String(avail[`${p}Airlines`] || '').replace(/\s/g, '');
  return {
    source: program,
    sourceName: PROGRAM_NAMES[program] || program,
    available: true,
    waitlist: false,
    confirmed: true,
    cabin: cabin.name,
    symbol: '○',
    flightNumber: airlines ? `${airlines}-any` : 'any',
    depTime: '', arrTime: '', duration: '',
    stops: [],
    layover: avail[`${p}Direct`] === true ? false : null,
    isMixedCabin: false,
    cabinDesc: `${cabin.name} via ${PROGRAM_NAMES[program] || program}`,
    routeDesc: '',
    miles: Number.isFinite(miles) && miles > 0 ? miles : null,
    taxUsd: null,
    remainingSeats: avail[`${p}RemainingSeats`] ?? null,
    format: 'seats.aero',
  };
}

/** Fetch every availability row for one origin/destination/date window, following pagination. */
async function fetchRoute({ from, to, startDate, endDate, cabins }, { apiKey, fetchImpl = fetch, sources, directOnly } = {}) {
  const rows = [];
  const seen = new Set();
  let cursor = null;
  let skip = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const qs = new URLSearchParams({
      origin_airport: from,
      destination_airport: to,
      start_date: startDate,
      end_date: endDate,
      cabins: cabins.join(','),
      take: String(PAGE_SIZE),
      include_trips: 'true',
    });
    if (sources) qs.set('sources', sources);
    if (directOnly) qs.set('only_direct_flights', 'true');
    if (cursor != null) { qs.set('cursor', String(cursor)); qs.set('skip', String(skip)); }

    const res = await fetchImpl(`${API_BASE}/search?${qs}`, {
      headers: { 'Partner-Authorization': apiKey, accept: 'application/json' },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`seats.aero HTTP ${res.status}: ${body.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    const json = await res.json();
    const data = Array.isArray(json.data) ? json.data : [];
    for (const row of data) {
      if (row.ID && seen.has(row.ID)) continue;
      if (row.ID) seen.add(row.ID);
      rows.push(row);
    }
    if (!json.hasMore || data.length === 0) break;
    cursor = json.cursor ?? cursor;
    skip += data.length;
  }
  return rows;
}

/**
 * Turn raw availability rows into per-(date, cabin) entries in the same shape
 * runParallel emits: { route, cabin, date, results }. A combo that was queried
 * but has no seats gets results [{ noResults: true }] so detectGoneFlights
 * counts it as searched (miss) — same as an empty ANA search.
 */
function rowsToEntries(route, rows) {
  const routeLabel = `${route.from}→${route.to}`;
  const byCombo = new Map(); // "date|cabinKey" → results[]
  for (const [date, cabinKeys] of Object.entries(route.dates || {})) {
    for (const k of cabinKeys) if (CABINS[k]) byCombo.set(`${date}|${k}`, []);
  }

  for (const avail of rows) {
    const date = avail.Date || String(avail.ParsedDate || '').slice(0, 10);
    for (const [cabinKey, cabin] of Object.entries(CABINS)) {
      const bucket = byCombo.get(`${date}|${cabinKey}`);
      if (!bucket) continue;
      if (!avail[`${cabin.prefix}Available`]) continue;
      const trips = (avail.AvailabilityTrips || []).filter(t =>
        String(t.Cabin || '').toLowerCase() === cabin.api);
      if (trips.length > 0) {
        for (const t of trips) bucket.push(tripToResult(t, avail, cabinKey));
      } else {
        bucket.push(summaryToResult(avail, cabinKey));
      }
    }
  }

  const entries = [];
  for (const [combo, results] of byCombo) {
    const [date, cabinKey] = combo.split('|');
    // Same program + flight can appear on several rows (e.g. refreshed twice) — keep cheapest.
    const best = new Map();
    for (const r of results) {
      const id = `${r.source}|${r.flightNumber}`;
      const cur = best.get(id);
      if (!cur || (r.miles ?? Infinity) < (cur.miles ?? Infinity)) best.set(id, r);
    }
    entries.push({
      route: routeLabel,
      cabin: cabinComboName(cabinKey),
      date,
      results: best.size > 0 ? [...best.values()] : [{ noResults: true }],
      _source: SOURCE_TAG,
    });
  }
  return entries;
}

/**
 * Search every tracked route on seats.aero. One API call (plus pagination) per
 * route covering its earliest → latest tracked date. Calls onResult(entry) per
 * (date, cabin) like runParallel, and returns all entries.
 * A route whose request fails contributes no entries, so GONE detection skips
 * its combos for this cycle.
 */
async function searchSeatsAero(routes, onResult = null, opts = {}) {
  const apiKey = opts.apiKey ?? process.env.SEATS_AERO_API_KEY;
  if (!apiKey) return { entries: [], enabled: false, errors: [] };
  const log = opts.log || (msg => console.log(`[SeatsAero] ${msg}`));
  const sources = opts.sources ?? (process.env.SEATS_AERO_SOURCES || '').replace(/\s/g, '');
  const directOnly = opts.directOnly ?? process.env.SEATS_AERO_DIRECT_ONLY === 'true';

  const entries = [];
  const errors = [];
  for (const route of routes) {
    const dates = Object.keys(route.dates || {}).sort();
    const cabinKeys = [...new Set(Object.values(route.dates || {}).flat())].filter(k => CABINS[k]);
    if (dates.length === 0 || cabinKeys.length === 0) continue;

    let rows;
    try {
      rows = await fetchRoute({
        from: route.from, to: route.to,
        startDate: dates[0], endDate: dates[dates.length - 1],
        cabins: cabinKeys.map(k => CABINS[k].api),
      }, { apiKey, fetchImpl: opts.fetchImpl, sources, directOnly });
    } catch (err) {
      log(`${route.from}→${route.to} failed: ${err.message}`);
      errors.push({ route: `${route.from}→${route.to}`, error: err.message, status: err.status });
      continue;
    }

    const routeEntries = rowsToEntries(route, rows);
    const hits = routeEntries.reduce((n, e) => n + (e.results[0]?.noResults ? 0 : e.results.length), 0);
    log(`${route.from}→${route.to} ${dates[0]}..${dates[dates.length - 1]}: ${rows.length} row(s), ${hits} matching trip(s)`);
    for (const entry of routeEntries) {
      entries.push(entry);
      if (onResult) {
        try { await onResult(entry); }
        catch (e) { log(`onResult callback error: ${e.message}`); }
      }
    }
  }
  return { entries, enabled: true, errors };
}

module.exports = {
  searchSeatsAero, fetchRoute, rowsToEntries, tripToResult, summaryToResult,
  minutesToDuration, taxesToUsd, SOURCE_TAG, CABINS,
};
