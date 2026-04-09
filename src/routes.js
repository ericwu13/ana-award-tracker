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
 * Parse a date input string. Accepts:
 *   "2026-10-15"  → ["2026-10-15"]
 *   "2026-10"     → ["2026-10-04", "2026-10-11", "2026-10-18", "2026-10-25"]
 */
function parseDateInput(input) {
  const trimmed = input.trim();
  if (/^\d{4}-\d{2}$/.test(trimmed)) {
    return expandMonth(trimmed);
  }
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
 * Format the date for display: "2026-10-04" → "Oct 4"
 */
function shortDate(dateStr) {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const [, m, d] = dateStr.split('-');
  return `${months[parseInt(m) - 1]} ${parseInt(d)}`;
}

/**
 * Format a compact status summary for Discord.
 * Shows confirmed seats split by Premium Economy/Economy/Business. Skips waitlist.
 */
function formatStatus() {
  const { lastCheck, summary } = getStatusSummary();

  const lines = [];
  const lastCheckStr = lastCheck
    ? new Date(lastCheck).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })
    : 'Never';
  lines.push(`📊 **ANA Award Tracker** — Last check: ${lastCheckStr}`);
  lines.push('');

  for (const route of summary) {
    lines.push(`**${route.route}**`);
    lines.push('```');
    lines.push('Date        PE   Eco  Biz');
    lines.push('──────────────────────────');

    for (const ds of route.dates) {
      const dateLabel = shortDate(ds.date).padEnd(10);
      if (ds.peCount === 0 && ds.ecoCount === 0 && ds.bizCount === 0) {
        lines.push(`${dateLabel}  ❌    ❌    ❌`);
      } else {
        const pe  = ds.peCount  > 0 ? `${ds.peCount} ✅`  : ' ❌ ';
        const eco = ds.ecoCount > 0 ? `${ds.ecoCount} ✅` : ' ❌ ';
        const biz = ds.bizCount > 0 ? `${ds.bizCount} ✅` : ' ❌ ';
        lines.push(`${dateLabel}${pe.padStart(5)} ${eco.padStart(5)} ${biz.padStart(5)}`);
      }
    }

    lines.push('```');
  }

  if (summary.length === 0) {
    lines.push('No routes configured. Use `/track` to add routes.');
  }

  lines.push('_Use `/flights <from> <to> <class> <date>` for details_');
  return lines.join('\n');
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

    // Miles line (no taxes — user preference; parser no longer extracts them)
    if (f.miles) {
      lines.push(`  💰 ${f.miles.toLocaleString()} miles`);
    }

    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Format the full /routes list for Discord. Dates within a route are grouped
 * by their cabin signature so routes with mixed per-date cabin sets render
 * legibly (e.g. "PE+Biz: May 1, May 8 / PE+Eco+Biz: Jul 5").
 */
function formatRoutes() {
  const routes = loadRoutes();
  if (routes.length === 0) return 'No routes configured.';

  const lines = ['📋 **Tracked Routes**', ''];
  for (const r of routes) {
    lines.push(`**${r.from}→${r.to}**`);
    const groups = groupDatesByCabinSignature(r);
    if (groups.length === 0) {
      lines.push('  (no dates)');
      continue;
    }
    for (const group of groups) {
      const label = group.signature
        .split('+')
        .map(c => CABIN_KEYS[c] ? CABIN_KEYS[c].short : c)
        .join('+');
      const dateStr = group.dates.map(shortDate).join(', ');
      lines.push(`  ${label}: ${dateStr}`);
    }
  }
  return lines.join('\n');
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

module.exports = {
  // Filesystem-aware public API
  loadRoutes, saveRoutes, seedRoutesIfNeeded,
  addRoute, removeRoute,
  parseDateInput, expandMonth, shortDate,
  getStatusSummary, formatStatus, formatRoutes, formatFlights,
  cleanupExpiredDates, todayPST, minBookableDate,
  // Pure helpers (exposed for unit testing and for index.js)
  expandCabinKeyword, sortCabinKeys, migrateRoute,
  addDatesWithCabins, removeDatesFromRoute, groupDatesByCabinSignature,
  CABIN_KEYS, CABIN_ORDER,
};
