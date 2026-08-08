/**
 * Route configuration manager.
 * Reads/writes routes to data/routes.json, with .env ROUTES as initial seed.
 *
 * Data model (current):
 *   routes.json = { routes: [{ from, to, dates: { [YYYY-MM-DD]: CabinKey[] } }], updatedAt }
 *   CabinKey is one of: 'premium-economy' | 'economy' | 'business'
 *
 * Legacy model (auto-migrated on first load):
 *   { from, to, dates: ['YYYY-MM-DD', ...], cabin: 'both'|'all'|'economy'|'business'|'premium-economy' }
 *   The migration expands the route-level `cabin` into a per-date CabinKey[] so
 *   each date can later be updated independently without destroying other dates.
 */
const fs = require('fs');
const path = require('path');

const ROUTES_FILE = path.join(__dirname, '..', 'data', 'routes.json');
const STATE_FILE = path.join(__dirname, '..', 'data', 'state.json');

// Canonical cabin definitions. Keys are the kebab-case strings stored in routes.json.
const CABIN_KEYS = {
  'premium-economy': { code: 'CFF4', name: 'Premium Economy', short: 'PE' },
  'economy':         { code: 'CFF1', name: 'Economy',         short: 'Eco' },
  'business':        { code: 'CFF2', name: 'Business',        short: 'Biz' },
};
// Canonical ordering: Premium Economy → Economy → Business.
// Used for stable sort in storage and deterministic display grouping.
const CABIN_ORDER = ['premium-economy', 'economy', 'business'];

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MONTHS_FULL = ['January','February','March','April','May','June','July','August','September','October','November','December'];

/**
 * Expand a month string (e.g., "2026-10") into dates covering the month.
 * Each date gets its own direct search (no calendar ±3 day view).
 * Dates every 7 days to keep request load manageable under ANA's rate limits.
 */
function expandMonth(yearMonth) {
  const [year, month] = yearMonth.split('-').map(Number);
  const daysInMonth = new Date(year, month, 0).getDate();
  const dates = [];
  for (let day = 1; day <= daysInMonth; day += 7) {
    const mm = String(month).padStart(2, '0');
    const dd = String(day).padStart(2, '0');
    dates.push(`${year}-${mm}-${dd}`);
  }
  return dates;
}

/**
 * Expand a date range into daily dates.
 * "2026-07-10", "2026-07-13" → ["2026-07-10", "2026-07-11", "2026-07-12", "2026-07-13"]
 * If end < start, they're swapped silently so the user doesn't get an error.
 */
function expandDateRange(startStr, endStr) {
  let start = new Date(startStr + 'T00:00:00');
  let end = new Date(endStr + 'T00:00:00');
  if (isNaN(start) || isNaN(end)) return null;
  if (end < start) [start, end] = [end, start];

  const dates = [];
  const current = new Date(start);
  while (current <= end) {
    const y = current.getFullYear();
    const m = String(current.getMonth() + 1).padStart(2, '0');
    const d = String(current.getDate()).padStart(2, '0');
    dates.push(`${y}-${m}-${d}`);
    current.setDate(current.getDate() + 1);
  }
  return dates.length > 0 ? dates : null;
}

/**
 * Parse a date input string. Accepts:
 *   "2026-10-15"                       → ["2026-10-15"]
 *   "2026-10"                          → ["2026-10-01", "2026-10-08", ...] (weekly)
 *   "2026-07-10~2026-07-13"            → ["2026-07-10", ..., "2026-07-13"] (daily range)
 *   "2026-07-10 to 2026-07-13"         → same (natural language range)
 */
function parseDateInput(input) {
  const trimmed = input.trim();

  // Range: "2026-07-10~2026-07-13" or "2026-07-10 to 2026-07-13"
  const rangeMatch = trimmed.match(/^(\d{4}-\d{2}-\d{2})\s*(?:~|to)\s*(\d{4}-\d{2}-\d{2})$/i);
  if (rangeMatch) {
    return expandDateRange(rangeMatch[1], rangeMatch[2]);
  }

  // Month: "2026-10"
  if (/^\d{4}-\d{2}$/.test(trimmed)) {
    return expandMonth(trimmed);
  }

  // Single date: "2026-10-15"
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return [trimmed];
  }

  return null; // invalid
}

// ============================================================================
// Pure helpers (no filesystem access — unit-testable)
// ============================================================================

/**
 * Expand a Discord-facing cabin keyword into an array of internal cabin keys.
 * The 'both' keyword (default) expands to PE+Biz; 'all' expands to all three.
 * Unknown keywords fall back to 'both' to match the /track default.
 */
function expandCabinKeyword(keyword) {
  switch (keyword) {
    case 'economy':         return ['economy'];
    case 'business':        return ['business'];
    case 'premium-economy': return ['premium-economy'];
    case 'all':             return ['premium-economy', 'economy', 'business'];
    case 'both':
    default:                return ['premium-economy', 'business'];
  }
}

/**
 * Return cabin keys in canonical order (PE, Eco, Biz), deduplicated.
 */
function sortCabinKeys(keys) {
  const set = new Set(keys);
  return CABIN_ORDER.filter(c => set.has(c));
}

/**
 * Migrate a single route from the legacy shape (dates: string[], cabin: string)
 * to the current shape (dates: { [date]: CabinKey[] }). Returns a new object;
 * the input is not mutated. Already-migrated routes pass through unchanged.
 */
function migrateRoute(route) {
  if (Array.isArray(route.dates)) {
    const cabinKeys = sortCabinKeys(expandCabinKeyword(route.cabin || 'both'));
    const newDates = {};
    for (const d of route.dates) {
      newDates[d] = [...cabinKeys];
    }
    const { cabin, dates: _dates, ...rest } = route;
    return { ...rest, dates: newDates };
  }
  return route;
}

/**
 * Add dates with cabins to a route, additively. Mutates `route.dates`.
 *
 * For each date in `dates`:
 *   - If new, create the entry with the given cabin keys.
 *   - If existing, union the given cabin keys into the existing set.
 *
 * Returns { newlyAddedDates, updatedDates }:
 *   - newlyAddedDates: dates that did not exist on the route before
 *   - updatedDates: dates that existed but gained new cabins
 *
 * Dates that existed with all of the given cabins already are no-ops and
 * appear in neither list.
 */
function addDatesWithCabins(route, dates, cabinKeys) {
  if (!route.dates || Array.isArray(route.dates)) {
    route.dates = {};
  }
  const newCabins = sortCabinKeys(cabinKeys);
  const newlyAddedDates = [];
  const updatedDates = [];

  for (const date of dates) {
    if (!route.dates[date]) {
      route.dates[date] = [...newCabins];
      newlyAddedDates.push(date);
      continue;
    }
    const existing = new Set(route.dates[date]);
    const before = existing.size;
    for (const c of newCabins) existing.add(c);
    if (existing.size > before) {
      route.dates[date] = sortCabinKeys([...existing]);
      updatedDates.push(date);
    }
    // else: no-op, already has all requested cabins
  }

  return { newlyAddedDates, updatedDates };
}

/**
 * Remove dates (or specific cabins from dates) from a route. Mutates `route.dates`.
 *
 * If `cabinKeys` is null/empty, each listed date is removed entirely.
 * If `cabinKeys` is provided, only those cabins are removed from each date;
 * if a date's cabin set becomes empty, the date is removed entirely.
 *
 * Returns { removedDates, updatedDates }:
 *   - removedDates: dates deleted from the route (either explicitly or because
 *                   their cabin set became empty)
 *   - updatedDates: dates that had cabins removed but still have >=1 remaining
 */
function removeDatesFromRoute(route, dates, cabinKeys = null) {
  const result = { removedDates: [], updatedDates: [] };
  if (!route.dates || Array.isArray(route.dates)) return result;

  const cabinsToRemove = cabinKeys && cabinKeys.length > 0 ? new Set(cabinKeys) : null;

  for (const date of dates) {
    if (!route.dates[date]) continue;

    if (!cabinsToRemove) {
      delete route.dates[date];
      result.removedDates.push(date);
      continue;
    }

    const remaining = route.dates[date].filter(c => !cabinsToRemove.has(c));
    if (remaining.length === 0) {
      delete route.dates[date];
      result.removedDates.push(date);
    } else if (remaining.length !== route.dates[date].length) {
      route.dates[date] = sortCabinKeys(remaining);
      result.updatedDates.push(date);
    }
    // else: no cabins actually removed (none matched), skip
  }

  return result;
}

/**
 * Group a route's dates by their cabin signature (canonical joined string)
 * for display. Returns an array of { signature, dates }, sorted by signature
 * ascending; each group's `dates` is sorted ascending.
 */
function groupDatesByCabinSignature(route) {
  if (!route.dates || Array.isArray(route.dates)) return [];
  const groups = new Map();
  for (const [date, cabinKeys] of Object.entries(route.dates)) {
    const sig = sortCabinKeys(cabinKeys).join('+');
    if (!groups.has(sig)) groups.set(sig, []);
    groups.get(sig).push(date);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([signature, dates]) => ({ signature, dates: dates.slice().sort() }));
}

// ============================================================================
// Filesystem-aware functions
// ============================================================================

/**
 * Load routes from data/routes.json. Auto-migrates legacy per-route `cabin`
 * entries into the current per-date cabin schema on first load after upgrade.
 * A pre-migration backup is written to data/routes.json.bak-pre-migration
 * (but only once — existing backups are never overwritten).
 */
function loadRoutes() {
  let routes = [];
  try {
    if (fs.existsSync(ROUTES_FILE)) {
      const data = JSON.parse(fs.readFileSync(ROUTES_FILE, 'utf8'));
      routes = data.routes || [];
    }
  } catch (e) {
    console.log('[Routes] Could not read routes.json:', e.message);
    return [];
  }

  if (routes.length === 0) {
    // Fallback to .env (already produces new-format routes)
    return parseEnvRoutes();
  }

  // Detect and migrate legacy format (dates as array)
  const needsMigration = routes.some(r => Array.isArray(r.dates));
  if (!needsMigration) return routes;

  // Preserve the original file before migrating (idempotent)
  const backup = ROUTES_FILE + '.bak-pre-migration';
  try {
    if (!fs.existsSync(backup)) {
      fs.copyFileSync(ROUTES_FILE, backup);
      console.log(`[Routes] Wrote pre-migration backup to ${path.basename(backup)}`);
    }
  } catch (e) {
    console.log('[Routes] Warning: could not create migration backup:', e.message);
  }

  const migrated = routes.map(migrateRoute);
  saveRoutes(migrated);
  const legacyCount = routes.filter(r => Array.isArray(r.dates)).length;
  console.log(`[Routes] Migrated ${legacyCount} route(s) to per-date cabin format`);
  return migrated;
}

/**
 * Parse ROUTES from .env into the current route shape.
 * Format: "TPE-SFO:2026-10-01,2026-10-08;SFO-TPE:2026-11-01"
 * All dates get the default cabin set (PE+Biz).
 */
function parseEnvRoutes() {
  const routesStr = process.env.ROUTES;
  if (!routesStr) return [];

  const defaultCabins = expandCabinKeyword('both');
  return routesStr.split(';').map(r => r.trim()).filter(Boolean).map(entry => {
    const [route, datesStr] = entry.split(':');
    const [from, to] = route.split('-');
    const dateArr = (datesStr || '').split(',').map(d => d.trim()).filter(Boolean);
    const dates = {};
    for (const d of dateArr) dates[d] = [...defaultCabins];
    return { from, to, dates };
  });
}

/**
 * Save routes to data/routes.json.
 */
function saveRoutes(routes) {
  fs.mkdirSync(path.dirname(ROUTES_FILE), { recursive: true });
  fs.writeFileSync(ROUTES_FILE, JSON.stringify({ routes, updatedAt: new Date().toISOString() }, null, 2));
}

/**
 * Seed routes.json from .env if it doesn't exist yet.
 */
function seedRoutesIfNeeded() {
  if (!fs.existsSync(ROUTES_FILE)) {
    const routes = parseEnvRoutes();
    if (routes.length > 0) {
      saveRoutes(routes);
      console.log(`[Routes] Seeded routes.json from .env (${routes.length} routes)`);
    }
  }
}

/**
 * Add dates+cabins to a route. Creates the route if it doesn't exist.
 * @param {string} cabin - keyword: 'both' | 'all' | 'economy' | 'business' | 'premium-economy'
 *                         (default 'both' = PE+Biz)
 * Returns { route, newlyAddedDates, updatedDates, cabinKeys, totalDates }.
 * Never destroys existing cabins on existing dates — always additive.
 */
function addRoute(from, to, dates, cabin = 'both') {
  const routes = loadRoutes();
  let route = routes.find(r => r.from === from && r.to === to);

  if (!route) {
    route = { from, to, dates: {} };
    routes.push(route);
  }

  const cabinKeys = expandCabinKeyword(cabin);
  const { newlyAddedDates, updatedDates } = addDatesWithCabins(route, dates, cabinKeys);

  saveRoutes(routes);
  return {
    route,
    newlyAddedDates,
    updatedDates,
    cabinKeys,
    totalDates: Object.keys(route.dates).length,
  };
}

/**
 * Remove dates (or specific cabins from dates) from a route.
 *
 * @param {string|null} cabin - optional keyword. If provided, only that cabin
 *                              (or cabin set, in the case of 'all'/'both') is
 *                              removed from each listed date. If omitted, the
 *                              entire date is removed.
 *
 * If `dates` is null/empty, the entire route is removed.
 * Returns {
 *   removed: boolean,           // route existed
 *   removedEntireRoute: boolean,
 *   removedDates: string[],     // dates deleted from the route
 *   updatedDates: string[],     // dates with cabins removed but still present
 *   remainingDates: number,
 * }.
 */
function removeRoute(from, to, dates = null, cabin = null) {
  const routes = loadRoutes();
  const idx = routes.findIndex(r => r.from === from && r.to === to);

  if (idx === -1) {
    return { removed: false, removedEntireRoute: false, removedDates: [], updatedDates: [], remainingDates: 0 };
  }

  const route = routes[idx];

  // No dates specified → remove the entire route
  if (!dates || dates.length === 0) {
    routes.splice(idx, 1);
    saveRoutes(routes);
    return { removed: true, removedEntireRoute: true, removedDates: [], updatedDates: [], remainingDates: 0 };
  }

  const cabinKeys = cabin ? expandCabinKeyword(cabin) : null;
  const { removedDates, updatedDates } = removeDatesFromRoute(route, dates, cabinKeys);

  // If the route has no dates left, remove it entirely
  const remainingDates = Object.keys(route.dates).length;
  if (remainingDates === 0) {
    routes.splice(idx, 1);
  }

  saveRoutes(routes);
  return {
    removed: true,
    removedEntireRoute: remainingDates === 0,
    removedDates,
    updatedDates,
    remainingDates,
  };
}

/**
 * Load state and build a per-route, per-date status summary.
 */
function getStatusSummary() {
  const routes = loadRoutes();
  let state;
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    state = { flights: {} };
  }

  const flights = state.flights || {};
  const summary = [];

  for (const route of routes) {
    const routeLabel = `${route.from}→${route.to}`;
    const dateSummaries = [];

    for (const date of Object.keys(route.dates).sort()) {
      // Find confirmed flights for this route+date (skip waitlist)
      const matching = Object.entries(flights).filter(([key, f]) => {
        return key.startsWith(`${routeLabel}|${date}|`) && f.status === 'confirmed';
      });

      if (matching.length === 0) {
        dateSummaries.push({ date, peCount: 0, ecoCount: 0, bizCount: 0 });
        continue;
      }

      // Split by cabin class. "Premium Economy" must be checked BEFORE "Economy"
      // because the substring "economy" is contained in "premium economy".
      const pe = matching.filter(([, f]) => {
        const desc = (f.cabinDesc || '').toLowerCase();
        return desc.includes('premium economy');
      });
      const eco = matching.filter(([, f]) => {
        const desc = (f.cabinDesc || '').toLowerCase();
        return desc.includes('economy') && !desc.includes('premium') && !desc.includes('business');
      });
      const biz = matching.filter(([, f]) => {
        const desc = (f.cabinDesc || '').toLowerCase();
        return desc.includes('business');
      });

      dateSummaries.push({ date, peCount: pe.length, ecoCount: eco.length, bizCount: biz.length });
    }

    summary.push({ route: routeLabel, from: route.from, to: route.to, dates: dateSummaries });
  }

  return {
    lastCheck: state.lastCheck,
    totalFlights: Object.keys(flights).length,
    summary,
  };
}

/**
 * Format the date for display: "2026-10-04" → "Oct 4 2026"
 */
function shortDate(dateStr) {
  const [y, m, d] = dateStr.split('-');
  return `${MONTHS[parseInt(m) - 1]} ${parseInt(d)} ${y}`;
}

/**
 * True if bIso is the calendar day immediately after aIso. Both are
 * 'YYYY-MM-DD'. Uses UTC epoch days so month/year/DST boundaries are exact.
 */
function isNextDay(aIso, bIso) {
  const [ay, am, ad] = aIso.split('-').map(Number);
  const [by, bm, bd] = bIso.split('-').map(Number);
  return Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad) === 86400000;
}

/**
 * Format one consecutive run [startIso..endIso] as a compact label.
 * `includeYear` appends the year to single-year runs (callers suppress it
 * when a shared year is printed once for the whole line). A run that itself
 * spans two years always shows both years regardless of `includeYear`.
 *   'Dec 23'..'Dec 26' → "Dec 23–26"      (same month)
 *   'Dec 29'..'Dec 31' + 'Jan 1' → "Dec 29, 2026 – Jan 1, 2027"
 */
function formatRun(startIso, endIso, includeYear) {
  const [sy, sm, sd] = startIso.split('-').map(Number);
  const [ey, em, ed] = endIso.split('-').map(Number);
  const sMon = MONTHS[sm - 1], eMon = MONTHS[em - 1];
  const yr = y => (includeYear ? `, ${y}` : '');

  if (startIso === endIso)    return `${sMon} ${sd}${yr(sy)}`;
  if (sy === ey && sm === em) return `${sMon} ${sd}–${ed}${yr(sy)}`;
  if (sy === ey)              return `${sMon} ${sd} – ${eMon} ${ed}${yr(sy)}`;
  // Cross-year run: show both years only when the caller wants years at all
  // (under a month/year header the years are redundant and Dec→Jan is obvious).
  return includeYear
    ? `${sMon} ${sd}, ${sy} – ${eMon} ${ed}, ${ey}`
    : `${sMon} ${sd} – ${eMon} ${ed}`;
}

/**
 * Collapse a list of ISO dates into a compact, human-readable string.
 * Consecutive calendar days merge into ranges; the year is printed once at the
 * end when every date shares it, otherwise per-run. Pass withYear=false to omit
 * years entirely (used when a month/year header already supplies the context).
 *   ['2026-12-23','2026-12-24','2026-12-25','2026-12-26'] → "Dec 23–26, 2026"
 *   ['2026-12-15','2026-12-22','2026-12-29']              → "Dec 15, Dec 22, Dec 29, 2026"
 *   ['2026-12-30','2026-12-31','2027-01-01']              → "Dec 30, 2026 – Jan 1, 2027"
 *   (…, false)                                            → "Dec 30 – Jan 1"
 */
function formatDateRanges(isoDates, withYear = true) {
  const sorted = [...new Set(isoDates)].sort();
  if (sorted.length === 0) return '';

  // Group into runs of consecutive calendar days.
  const runs = [];
  let start = sorted[0], prev = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (isNextDay(prev, sorted[i])) { prev = sorted[i]; }
    else { runs.push([start, prev]); start = prev = sorted[i]; }
  }
  runs.push([start, prev]);

  // Header/context supplies the year — render bare month+day runs.
  if (!withYear) return runs.map(([s, e]) => formatRun(s, e, false)).join(', ');

  // If every date shares one year, print it once at the end instead of per-run.
  const years = new Set();
  for (const [s, e] of runs) { years.add(s.slice(0, 4)); years.add(e.slice(0, 4)); }
  const sharedYear = years.size === 1 ? [...years][0] : null;

  const parts = runs.map(([s, e]) => formatRun(s, e, !sharedYear));
  return sharedYear ? `${parts.join(', ')}, ${sharedYear}` : parts.join(', ');
}

/**
 * Format a compact status summary for Discord.
 * Shows confirmed seats split by Premium Economy/Economy/Business. Skips waitlist.
 */
function formatStatus() {
  const { lastCheck, summary } = getStatusSummary();
  return renderStatus(lastCheck, summary);
}

/**
 * Pure renderer for /status — takes the timestamp + summary from
 * getStatusSummary() and returns the Discord message. Split out from
 * formatStatus so it can be unit-tested without touching the filesystem.
 */
function renderStatus(lastCheck, summary) {
  const lastCheckStr = lastCheck
    ? new Date(lastCheck).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })
    : 'never';
  const header = `📊 **ANA Award Tracker** · checked ${lastCheckStr}`;

  if (summary.length === 0) {
    return `${header}\n\nNo routes configured. Use \`/track\` to add routes.`;
  }

  const monthDay = (iso) => { const [, m, d] = iso.split('-'); return `${MONTHS[parseInt(m) - 1]} ${parseInt(d)}`; };
  const CABINS = [['peCount', 'PE'], ['ecoCount', 'Eco'], ['bizCount', 'Biz']];
  const hasSeats = (ds) => ds.peCount + ds.ecoCount + ds.bizCount > 0;

  // "Bookable now" — only routes/dates with ≥1 confirmed seat. Each date lists
  // the cabins available on it (e.g. "Dec 22 Eco×5"). Emoji live only in the
  // section header, never in aligned columns, so nothing shifts.
  const bookable = [];
  for (const route of summary) {
    const cells = route.dates
      .filter(hasSeats)
      .map(ds => `${monthDay(ds.date)} ${CABINS.filter(([k]) => ds[k] > 0).map(([k, label]) => `${label}×${ds[k]}`).join(' ')}`);
    if (cells.length) bookable.push(`  ${route.route.padEnd(8)} ${cells.join(' · ')}`);
  }

  // Coverage tally — dates-with-seats / tracked, hottest routes first, 2 per row.
  const cov = summary
    .map(route => ({ label: route.route, withSeats: route.dates.filter(hasSeats).length, total: route.dates.length }))
    .sort((a, b) => b.withSeats - a.withSeats || a.label.localeCompare(b.label))
    .map(c => `${c.label.padEnd(8)}${`${c.withSeats}/${c.total}`.padEnd(6)}`);
  const covRows = [];
  for (let i = 0; i < cov.length; i += 2) covRows.push(('  ' + cov.slice(i, i + 2).join('  ')).trimEnd());

  const body = ['```', '✅ BOOKABLE NOW'];
  body.push(...(bookable.length ? bookable : ['  — none right now —']));
  body.push('', 'COVERAGE  (dates with seats / tracked)', ...covRows, '```');

  return [header, ...body, '_Use `/flights <from> <to> <class> <date>` for details_'].join('\n');
}

/**
 * Format detailed flight list for a specific route+date+cabin.
 * Only shows confirmed seats (skips waitlist).
 */
function formatFlights(from, to, dateInput, cabin) {
  let state;
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return 'No data yet. Run `/check` first.';
  }

  const routeLabel = `${from}→${to}`;
  const flights = state.flights || {};

  // Find matching flights — filter by route, date prefix, and skip waitlist
  const matching = Object.entries(flights).filter(([key, f]) => {
    if (!key.startsWith(`${routeLabel}|`)) return false;
    if (dateInput && !key.includes(`|${dateInput}`)) return false;
    if (f.status !== 'confirmed') return false; // skip waitlist
    return true;
  });

  // Filter by cabin if specified. "Economy" must not match "Premium Economy",
  // so we use exact-class matching instead of substring.
  const filtered = cabin
    ? matching.filter(([, f]) => {
        const desc = (f.cabinDesc || '').toLowerCase();
        const wanted = cabin.toLowerCase();
        if (wanted === 'premium economy') return desc.includes('premium economy');
        if (wanted === 'economy')         return desc.includes('economy') && !desc.includes('premium') && !desc.includes('business');
        if (wanted === 'business')        return desc.includes('business');
        return desc.includes(wanted);
      })
    : matching;

  const dateLabel = dateInput.length === 7 ? dateInput : shortDate(dateInput);
  const header = `✈️ **${routeLabel} | ${cabin || 'All'} | ${dateLabel}**`;

  if (filtered.length === 0) {
    return `${header}\n\nNo confirmed ${cabin || ''} seats found.`;
  }

  const lines = [header, ''];

  for (const [, f] of filtered) {
    const flightNum = f.flightNumber || 'unknown';
    // Clean up cabin desc — remove duplicate flight number
    let cabinInfo = f.cabinDesc || '';
    if (flightNum && cabinInfo) {
      cabinInfo = cabinInfo.replace(new RegExp(flightNum.replace('+', '\\+') + '\\s*', 'g'), '').trim();
    }

    // Use search route + stops, not routeDesc (which can show wrong direction for codeshares)
    const routeInfo = f.routeDesc && f.routeDesc.includes('→')
      ? `${from}→${to}` + (f.routeDesc.split('→').length > 2 ? ' via ' + f.routeDesc.split('→').slice(1, -1).map(s => s.trim()).join(', ') : '')
      : `${from}→${to}`;
    const duration = f.duration ? ` | ${f.duration}` : '';
    const date = f.date ? shortDate(f.date) : '';

    lines.push(`✅ **${flightNum}** — ${date}`);
    lines.push(`  ${routeInfo}${duration}`);
    if (cabinInfo) lines.push(`  ${cabinInfo}`);

    // Cost line — miles + cash co-pay for taxes/fees.
    if (f.miles) {
      let cost = `${f.miles.toLocaleString()} miles`;
      if (f.taxUsd != null) cost += ` + $${f.taxUsd.toFixed(2)}`;
      lines.push(`  💰 ${cost}`);
    }

    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Format the full /routes list for Discord as a chronological timeline.
 *
 * Rather than grouping by route, entries are ordered by date and sectioned
 * under month headers, so the list answers "for this date, what routes am I
 * tracking?" at a glance. Each entry is one (route × cabin-set) with its
 * consecutive days collapsed into ranges:
 *
 *   DECEMBER 2026
 *     Dec 6–13        SFO→TPE  Biz
 *     Dec 15–19       SFO→TPE  PE · Eco · Biz
 *     Dec 29 – Jan 1  HND→SFO  PE
 */
function formatRoutes() {
  const routes = loadRoutes();

  // Flatten routes into timeline entries: one per (route, cabin-set) group.
  const entries = [];
  let totalDates = 0;
  for (const r of routes) {
    if (r.dates && !Array.isArray(r.dates)) totalDates += Object.keys(r.dates).length;
    for (const group of groupDatesByCabinSignature(r)) {
      const start = group.dates[0]; // groups arrive date-sorted
      entries.push({
        start,
        monthKey: start.slice(0, 7),
        route: `${r.from}→${r.to}`,
        dateLabel: formatDateRanges(group.dates, false), // month header carries the year
        cabins: group.signature.split('+').map(c => (CABIN_KEYS[c] ? CABIN_KEYS[c].short : c)).join(' · '),
      });
    }
  }

  if (entries.length === 0) {
    return '📋 **Tracked Routes**\n\nNothing tracked yet. Add one with `/track`.';
  }

  // Chronological, with route as a stable tiebreak for same-day starts.
  entries.sort((a, b) => a.start.localeCompare(b.start) || a.route.localeCompare(b.route));

  // Column widths for the monospace table.
  const dateW = Math.max(...entries.map(e => e.dateLabel.length));
  const routeW = Math.max(...entries.map(e => e.route.length));

  const routeWord = routes.length === 1 ? 'route' : 'routes';
  const dateWord = totalDates === 1 ? 'date' : 'dates';
  const out = [`📋 **Tracked Routes** — ${routes.length} ${routeWord} · ${totalDates} ${dateWord}`, '```'];

  let lastMonth = null;
  for (const e of entries) {
    if (e.monthKey !== lastMonth) {
      if (lastMonth !== null) out.push('');
      const [y, m] = e.monthKey.split('-').map(Number);
      out.push(`${MONTHS_FULL[m - 1]} ${y}`.toUpperCase());
      lastMonth = e.monthKey;
    }
    out.push(`  ${e.dateLabel.padEnd(dateW)}  ${e.route.padEnd(routeW)}  ${e.cabins}`);
  }
  out.push('```');
  return out.join('\n');
}

/**
 * Get today's date in YYYY-MM-DD format (PST timezone — relevant for ANA flights).
 */
function todayPST() {
  const now = new Date();
  return now.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

/**
 * Get the minimum bookable date (today + ANA's 96-hour booking deadline).
 * ANA requires award bookings at least 96 hours before boarding.
 * We use 4 full days as the cutoff (with a buffer for timezone slop).
 */
function minBookableDate() {
  const days = parseInt(process.env.MIN_BOOK_LEAD_DAYS || '4');
  const now = new Date();
  // Get today in PST
  const todayStr = todayPST(); // YYYY-MM-DD
  const [y, m, d] = todayStr.split('-').map(Number);
  const future = new Date(Date.UTC(y, m - 1, d + days));
  return future.toISOString().substring(0, 10);
}

/**
 * Remove dates that can't be booked (in the past OR within ANA's 96-hour window),
 * and clean up cached flights for those dates from state.json.
 *
 * Returns { removedDates: [{route, date, reason}], removedFlights: number }
 */
function cleanupExpiredDates() {
  const minDate = minBookableDate();
  const routes = loadRoutes();
  const removedDates = [];
  let routesChanged = false;

  for (const route of routes) {
    const expired = Object.keys(route.dates).filter(d => d < minDate);
    if (expired.length > 0) {
      for (const d of expired) {
        delete route.dates[d];
        removedDates.push({ route: `${route.from}→${route.to}`, date: d, reason: 'unbookable (past or within 96h)' });
      }
      routesChanged = true;
    }
  }

  if (routesChanged) {
    // Drop empty routes (no dates left)
    const nonEmpty = routes.filter(r => Object.keys(r.dates).length > 0);
    saveRoutes(nonEmpty);
  }

  // Clean up cached flights for removed dates
  let removedFlights = 0;
  if (removedDates.length > 0) {
    try {
      const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (state.flights) {
        const removedKeys = new Set(removedDates.map(rd => `${rd.route}|${rd.date}`));
        for (const key of Object.keys(state.flights)) {
          // Key format: "ROUTE|DATE|flightnums"
          const [route, date] = key.split('|');
          if (removedKeys.has(`${route}|${date}`)) {
            delete state.flights[key];
            removedFlights++;
          }
        }
        if (removedFlights > 0) {
          fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
        }
      }
    } catch (e) {
      console.log('[Routes] Could not clean state.json:', e.message);
    }
  }

  return { removedDates, removedFlights };
}

/**
 * Sync state.flights with current routes.json — remove any flight entries
 * whose (route, date) is no longer tracked. This is the same pruning that
 * runs at the end of each search cycle (index.js), exposed here so it can
 * be triggered on-demand via the /sync Discord command.
 *
 * Returns { prunedFlights, prunedLastChecked, remainingFlights }.
 */
function syncState() {
  const routes = loadRoutes();
  let state;
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { prunedFlights: 0, prunedLastChecked: 0, remainingFlights: 0 };
  }

  // Build the set of valid (route, date) combos from current routes.json
  const validRouteDates = new Set();
  for (const route of routes) {
    for (const date of Object.keys(route.dates || {})) {
      validRouteDates.add(`${route.from}→${route.to}|${date}`);
    }
  }

  // Prune flights
  let prunedFlights = 0;
  if (state.flights) {
    for (const key of Object.keys(state.flights)) {
      const [route, date] = key.split('|');
      if (!validRouteDates.has(`${route}|${date}`)) {
        delete state.flights[key];
        prunedFlights++;
      }
    }
  }

  // Prune lastChecked entries for combos that no longer exist
  let prunedLastChecked = 0;
  if (state.lastChecked) {
    for (const key of Object.keys(state.lastChecked)) {
      const [route, date] = key.split('|');
      if (!validRouteDates.has(`${route}|${date}`)) {
        delete state.lastChecked[key];
        prunedLastChecked++;
      }
    }
  }

  if (prunedFlights > 0 || prunedLastChecked > 0) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  }

  return {
    prunedFlights,
    prunedLastChecked,
    remainingFlights: Object.keys(state.flights || {}).length,
  };
}

module.exports = {
  // Filesystem-aware public API
  loadRoutes, saveRoutes, seedRoutesIfNeeded,
  addRoute, removeRoute, syncState,
  parseDateInput, expandMonth, expandDateRange, shortDate, formatDateRanges,
  getStatusSummary, formatStatus, renderStatus, formatRoutes, formatFlights,
  cleanupExpiredDates, todayPST, minBookableDate,
  // Pure helpers (exposed for unit testing and for index.js)
  expandCabinKeyword, sortCabinKeys, migrateRoute,
  addDatesWithCabins, removeDatesFromRoute, groupDatesByCabinSignature,
  CABIN_KEYS, CABIN_ORDER,
};
