/**
 * Route configuration manager.
 * Reads/writes routes to data/routes.json, with .env ROUTES as initial seed.
 */
const fs = require('fs');
const path = require('path');

const ROUTES_FILE = path.join(__dirname, '..', 'data', 'routes.json');
const STATE_FILE = path.join(__dirname, '..', 'data', 'state.json');

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

/**
 * Load routes from data/routes.json, falling back to .env ROUTES.
 */
function loadRoutes() {
  // Try routes.json first
  try {
    if (fs.existsSync(ROUTES_FILE)) {
      const data = JSON.parse(fs.readFileSync(ROUTES_FILE, 'utf8'));
      if (data.routes && data.routes.length > 0) {
        return data.routes;
      }
    }
  } catch (e) {
    console.log('[Routes] Could not read routes.json:', e.message);
  }

  // Fallback to .env
  return parseEnvRoutes();
}

/**
 * Parse ROUTES from .env.
 */
function parseEnvRoutes() {
  const routesStr = process.env.ROUTES;
  if (routesStr) {
    return routesStr.split(';').map(r => r.trim()).filter(Boolean).map(entry => {
      const [route, datesStr] = entry.split(':');
      const [from, to] = route.split('-');
      const dates = datesStr.split(',').map(d => d.trim());
      return { from, to, dates };
    });
  }
  return [];
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
 * Add dates to a route. Creates the route if it doesn't exist.
 * @param {string} cabin - 'economy', 'business', or 'both' (default)
 * Returns { route, addedDates, totalDates }
 */
function addRoute(from, to, dates, cabin = 'both') {
  const routes = loadRoutes();
  let route = routes.find(r => r.from === from && r.to === to);

  if (!route) {
    route = { from, to, dates: [], cabin: cabin };
    routes.push(route);
  }

  // Update cabin preference if explicitly set
  if (cabin !== 'both') {
    route.cabin = cabin;
  }

  const newDates = dates.filter(d => !route.dates.includes(d));
  route.dates.push(...newDates);
  route.dates.sort();

  saveRoutes(routes);
  return { route, addedDates: newDates, totalDates: route.dates.length };
}

/**
 * Remove dates from a route. If no dates specified, removes entire route.
 * Returns { removed, remainingDates }
 */
function removeRoute(from, to, dates = null) {
  const routes = loadRoutes();
  const idx = routes.findIndex(r => r.from === from && r.to === to);

  if (idx === -1) return { removed: false, remainingDates: 0 };

  if (!dates || dates.length === 0) {
    // Remove entire route
    routes.splice(idx, 1);
    saveRoutes(routes);
    return { removed: true, remainingDates: 0 };
  }

  // Remove specific dates
  routes[idx].dates = routes[idx].dates.filter(d => !dates.includes(d));

  if (routes[idx].dates.length === 0) {
    routes.splice(idx, 1);
  }

  saveRoutes(routes);
  return { removed: true, remainingDates: routes[idx]?.dates.length || 0 };
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

    for (const date of route.dates) {
      // Find confirmed flights for this route+date (skip waitlist)
      const matching = Object.entries(flights).filter(([key, f]) => {
        return key.startsWith(`${routeLabel}|${date}|`) && f.status === 'confirmed';
      });

      if (matching.length === 0) {
        dateSummaries.push({ date, ecoCount: 0, bizCount: 0 });
        continue;
      }

      // Split by cabin class
      const eco = matching.filter(([, f]) => {
        const desc = (f.cabinDesc || '').toLowerCase();
        return desc.includes('economy') && !desc.includes('business');
      });
      const biz = matching.filter(([, f]) => {
        const desc = (f.cabinDesc || '').toLowerCase();
        return desc.includes('business');
      });

      dateSummaries.push({ date, ecoCount: eco.length, bizCount: biz.length });
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
 * Shows confirmed seats split by Economy/Business. Skips waitlist.
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
    lines.push('Date       Eco  Biz');
    lines.push('─────────────────────');

    for (const ds of route.dates) {
      const dateLabel = shortDate(ds.date).padEnd(10);
      if (ds.ecoCount === 0 && ds.bizCount === 0) {
        lines.push(`${dateLabel}  ❌    ❌`);
      } else {
        const eco = ds.ecoCount > 0 ? `${ds.ecoCount} ✅` : ' ❌ ';
        const biz = ds.bizCount > 0 ? `${ds.bizCount} ✅` : ' ❌ ';
        lines.push(`${dateLabel}${eco.padStart(5)}  ${biz.padStart(5)}`);
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

  // Filter by cabin if specified
  const filtered = cabin
    ? matching.filter(([, f]) => {
        const desc = (f.cabinDesc || '').toLowerCase();
        return desc.includes(cabin.toLowerCase());
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
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Format routes list for display.
 */
function formatRoutes() {
  const routes = loadRoutes();
  if (routes.length === 0) return 'No routes configured.';

  const lines = ['📋 **Tracked Routes**', ''];
  for (const r of routes) {
    const dates = r.dates.map(d => shortDate(d)).join(', ');
    const cabin = r.cabin === 'economy' ? '(Eco)' : r.cabin === 'business' ? '(Biz)' : '(Eco+Biz)';
    lines.push(`**${r.from}→${r.to}** ${cabin}: ${dates}`);
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
    const validDates = route.dates.filter(d => d >= minDate);
    const expired = route.dates.filter(d => d < minDate);
    if (expired.length > 0) {
      route.dates = validDates;
      routesChanged = true;
      for (const d of expired) {
        removedDates.push({ route: `${route.from}→${route.to}`, date: d, reason: 'unbookable (past or within 96h)' });
      }
    }
  }

  if (routesChanged) {
    // Drop empty routes (no dates left)
    const nonEmpty = routes.filter(r => r.dates.length > 0);
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
  loadRoutes, saveRoutes, seedRoutesIfNeeded,
  addRoute, removeRoute,
  parseDateInput, expandMonth, shortDate,
  getStatusSummary, formatStatus, formatRoutes, formatFlights,
  cleanupExpiredDates, todayPST, minBookableDate,
};
