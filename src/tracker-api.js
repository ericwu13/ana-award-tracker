/**
 * Tracker operations as plain functions returning plain data.
 *
 * One layer under both front ends: the Discord slash commands format these
 * results as messages, and the chat agent (src/agent.js) exposes them to Claude
 * as tools. Everything here works on data/routes.json and data/state.json —
 * the same files the search cycle reads — so there is no IPC with the bot.
 *
 * Bad input is reported by throwing InputError with a message fit to show the
 * user (or to hand back to the model as a tool error).
 */
const fs = require('fs');
const path = require('path');
const {
  loadRoutes, addRoute, removeRoute, parseDateInput, expandDateRange, expandCabinKeyword,
  minBookableDate, CABIN_KEYS, DATA_DIR, STATE_FILE,
} = require('./routes');
const { readEvents } = require('./events');

class InputError extends Error {}

const TRACK_CABINS = ['both', 'all', 'economy', 'business', 'premium-economy'];
const SINGLE_CABINS = ['economy', 'business', 'premium-economy'];

function airport(code, label) {
  const c = String(code || '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(c)) throw new InputError(`${label} must be a 3-letter airport or city code (got "${code}")`);
  return c;
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { flights: {} }; }
}

/** 'premium-economy' | 'economy' | 'business' | null, from a flight's per-leg cabin text. */
function cabinClassOf(flight) {
  const desc = (flight.cabinDesc || flight.searchedCabin || '').toLowerCase();
  if (desc.includes('premium economy')) return 'premium-economy';
  if (desc.includes('business')) return 'business';
  if (desc.includes('economy')) return 'economy';
  return null;
}

// ----------------------------------------------------------------------------
// Tracking
// ----------------------------------------------------------------------------

/** Every tracked route with its per-date cabins. */
function listTracked() {
  const routes = loadRoutes().map(r => ({ from: r.from, to: r.to, dates: r.dates }));
  return {
    routes,
    totalDates: routes.reduce((n, r) => n + Object.keys(r.dates || {}).length, 0),
    earliestBookableDate: minBookableDate(),
  };
}

/** Collapse sorted ISO dates into runs of consecutive days: "A to B" or a single "A". */
function collapseDates(sortedDates) {
  const dayNumber = (iso) => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d) / 86400000; };
  const runs = [];
  for (const date of sortedDates) {
    const last = runs[runs.length - 1];
    if (last && dayNumber(date) - dayNumber(last.to) === 1) last.to = date;
    else runs.push({ from: date, to: date });
  }
  return runs.map(r => (r.from === r.to ? r.from : `${r.from} to ${r.to}`));
}

/**
 * The watch list in the shape that is easiest to read back correctly: one
 * entry per route with explicit counts, and consecutive days already collapsed
 * into ranges per cabin set. (A model handed 40 raw dates in a nested map
 * dropped a route and bridged a gap when summarising them.)
 */
function describeTracked() {
  const routes = loadRoutes().map(r => {
    const byCabins = new Map();
    for (const date of Object.keys(r.dates || {}).sort()) {
      const key = r.dates[date].join(' + ');
      if (!byCabins.has(key)) byCabins.set(key, []);
      byCabins.get(key).push(date);
    }
    return {
      route: `${r.from}→${r.to}`,
      dateCount: Object.keys(r.dates || {}).length,
      tracked: [...byCabins.entries()].map(([cabins, dates]) => ({ cabins, dates: collapseDates(dates) })),
    };
  });
  return {
    routeCount: routes.length,
    totalDates: routes.reduce((n, r) => n + r.dateCount, 0),
    routes,
    earliestBookableDate: minBookableDate(),
  };
}

/**
 * Work out what a track request would do, without doing it.
 * `date` is YYYY-MM-DD, YYYY-MM (weekly sample of that month) or a
 * "A~B" / "A to B" range; `until` turns `date` into the start of a daily range.
 */
function planTrack({ from, to, date, until, cabin = 'both' }) {
  const f = airport(from, 'from'), t = airport(to, 'to');
  if (f === t) throw new InputError('from and to are the same airport');
  if (!TRACK_CABINS.includes(cabin)) throw new InputError(`cabin must be one of ${TRACK_CABINS.join(', ')}`);
  if (!date) throw new InputError('date is required');

  const dates = until ? expandDateRange(String(date).trim(), String(until).trim()) : parseDateInput(String(date));
  if (!dates) throw new InputError(`could not read the date${until ? ' range' : ''} "${date}"${until ? ` → "${until}"` : ''}; use YYYY-MM-DD or YYYY-MM`);

  // The bot drops dates inside ANA's booking deadline on its next start; adding
  // them would look like it worked and then silently vanish.
  const min = minBookableDate();
  const tooSoon = dates.filter(d => d < min);
  const usable = dates.filter(d => d >= min);
  if (usable.length === 0) throw new InputError(`all of those dates are before ${min}, the earliest date ANA will still book`);

  const cabinKeys = expandCabinKeyword(cabin);
  const existing = (loadRoutes().find(r => r.from === f && r.to === t) || {}).dates || {};
  const newDates = usable.filter(d => !existing[d]);
  const widenedDates = usable.filter(d => existing[d] && cabinKeys.some(c => !existing[d].includes(c)));
  return { from: f, to: t, cabin, cabinKeys, dates: usable, newDates, widenedDates, skippedTooSoon: tooSoon };
}

/** Start tracking. Additive: never removes cabins already tracked on a date. */
function track(args) {
  const plan = planTrack(args);
  const { newlyAddedDates, updatedDates, totalDates } = addRoute(plan.from, plan.to, plan.dates, plan.cabin);
  return {
    route: `${plan.from}→${plan.to}`,
    cabins: plan.cabinKeys,
    addedDates: newlyAddedDates.slice().sort(),
    widenedDates: updatedDates.slice().sort(),
    skippedTooSoon: plan.skippedTooSoon,
    totalDatesOnRoute: totalDates,
  };
}

/**
 * Resolve which dates an untrack request refers to. Returns null for "the
 * whole route". A month (YYYY-MM) means every tracked date in that month, not
 * just the weekly sample `parseDateInput` would produce.
 */
function untrackDates({ from, to, date, until }) {
  if (!date) return null;
  const trimmed = String(date).trim();
  if (until) {
    const range = expandDateRange(trimmed, String(until).trim());
    if (!range) throw new InputError(`Invalid date range: \`${date}\` to \`${until}\``);
    return range;
  }
  const parsed = parseDateInput(trimmed);
  if (!parsed) throw new InputError(`Invalid date format: \`${date}\``);
  if (/^\d{4}-\d{2}$/.test(trimmed)) {
    const route = loadRoutes().find(r => r.from === from && r.to === to);
    if (route && route.dates) {
      return [...new Set([...Object.keys(route.dates).filter(d => d.startsWith(trimmed)), ...parsed])];
    }
  }
  return parsed;
}

/** Work out what an untrack request would remove, without doing it. */
function planUntrack({ from, to, date, until, cabin }) {
  const f = airport(from, 'from'), t = airport(to, 'to');
  if (cabin && !SINGLE_CABINS.includes(cabin)) throw new InputError(`cabin must be one of ${SINGLE_CABINS.join(', ')}`);
  const route = loadRoutes().find(r => r.from === f && r.to === t);
  if (!route) return { from: f, to: t, exists: false, entireRoute: false, affectedDates: [] };
  const dates = untrackDates({ from: f, to: t, date, until });
  const tracked = Object.keys(route.dates || {});
  const affected = dates === null
    ? tracked
    : dates.filter(d => route.dates[d] && (!cabin || route.dates[d].includes(cabin)));
  return {
    from: f, to: t, exists: true, cabin: cabin || null,
    entireRoute: dates === null || (!cabin && affected.length === tracked.length),
    affectedDates: affected.slice().sort(),
  };
}

/**
 * Stop tracking a route, some of its dates, or one cabin on those dates, and
 * drop the cached flights that belonged to what was removed.
 *
 * Returns removeRoute()'s result plus `clearedFlights`.
 */
function untrack({ from, to, date, until, cabin }) {
  const f = airport(from, 'from'), t = airport(to, 'to');
  if (cabin && !SINGLE_CABINS.includes(cabin)) throw new InputError(`cabin must be one of ${SINGLE_CABINS.join(', ')}`);
  const dates = untrackDates({ from: f, to: t, date, until });

  const result = removeRoute(f, t, dates, cabin || null);
  if (!result.removed) return { ...result, clearedFlights: 0 };

  // Clean cached flights + lastChecked for what was removed. For a whole-month
  // removal match on the month prefix rather than result.removedDates, which
  // also catches entries orphaned by older untrack calls.
  const month = date && /^\d{4}-\d{2}$/.test(String(date).trim()) && !until ? String(date).trim() : null;
  const routeLabel = `${f}→${t}`;
  const shouldClean = (key) => {
    if (!key.startsWith(`${routeLabel}|`)) return false;
    if (result.removedEntireRoute) return true;
    if (!cabin && month) {
      const [, flightDate] = key.split('|');
      return !!flightDate && flightDate.startsWith(month);
    }
    return result.removedDates.some(d => key.startsWith(`${routeLabel}|${d}|`));
  };

  let clearedFlights = 0;
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    for (const key of Object.keys(state.flights || {})) {
      if (shouldClean(key)) { delete state.flights[key]; clearedFlights++; }
    }
    for (const key of Object.keys(state.lastChecked || {})) {
      if (shouldClean(key)) delete state.lastChecked[key];
    }
    if (clearedFlights > 0) fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch {
    // state.json unreadable — the route change itself still stands
  }
  return { ...result, clearedFlights };
}

// ----------------------------------------------------------------------------
// Reading results
// ----------------------------------------------------------------------------

/**
 * Seats the tracker currently knows about, from the last searches.
 * All filters are optional; confirmed seats only unless includeWaitlist.
 */
function getFlights({ from, to, dateFrom, dateTo, cabin, includeWaitlist = false, maxMiles, limit = 60 } = {}) {
  const f = from ? airport(from, 'from') : null;
  const t = to ? airport(to, 'to') : null;
  if (cabin && !SINGLE_CABINS.includes(cabin)) throw new InputError(`cabin must be one of ${SINGLE_CABINS.join(', ')}`);
  for (const [name, v] of [['dateFrom', dateFrom], ['dateTo', dateTo]]) {
    if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new InputError(`${name} must be YYYY-MM-DD`);
  }

  const state = loadState();
  const matches = [];
  for (const fl of Object.values(state.flights || {})) {
    const [rf, rt] = String(fl.route || '').split('→');
    if (f && rf !== f) continue;
    if (t && rt !== t) continue;
    if (dateFrom && fl.date < dateFrom) continue;
    if (dateTo && fl.date > dateTo) continue;
    if (fl.status !== 'confirmed' && !(includeWaitlist && fl.status === 'waitlist')) continue;
    const cls = cabinClassOf(fl);
    if (cabin && cls !== cabin) continue;
    if (maxMiles != null && !(fl.miles != null && fl.miles <= maxMiles)) continue;
    matches.push({
      route: fl.route, date: fl.date, flight: fl.flightNumber, status: fl.status,
      cabin: cls ? CABIN_KEYS[cls].name : fl.searchedCabin, legs: fl.cabinDesc || null,
      routing: fl.routeDesc || null, duration: fl.duration || null,
      miles: fl.miles ?? null, taxUsd: fl.taxUsd ?? null,
      firstSeen: fl.firstSeen, lastSeen: fl.lastSeen,
      ...(fl.missed ? { missedLastChecks: fl.missed } : {}),
    });
  }
  matches.sort((a, b) => a.date.localeCompare(b.date) || a.route.localeCompare(b.route) || (a.miles ?? Infinity) - (b.miles ?? Infinity));
  return {
    lastCheck: state.lastCheck || null,
    count: matches.length,
    flights: matches.slice(0, limit),
    ...(matches.length > limit ? { truncated: matches.length - limit } : {}),
  };
}

/** Is a search cycle running right now? (run-once.js holds data/run.lock with its pid.) */
function isCheckRunning() {
  try {
    const pid = parseInt(fs.readFileSync(path.join(DATA_DIR, 'run.lock'), 'utf8').trim(), 10);
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Tracker health: when it last ran, how much it covered, and whether the ANA session looks usable. */
function getStatus() {
  const state = loadState();
  const flights = Object.values(state.flights || {});
  const routes = loadRoutes();

  // Per CLAUDE.md, a recent cookies.json proves nothing; the presence of the
  // `personal` and `_abck` cookies plus a run that actually checked combos does.
  let cookies = { present: false };
  try {
    const list = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'cookies.json'), 'utf8'));
    cookies = { present: true, hasPersonal: list.some(c => c.name === 'personal'), hasAbck: list.some(c => c.name === '_abck') };
  } catch { /* no cookie file */ }

  return {
    now: new Date().toISOString(),
    lastCheck: state.lastCheck || null,
    checkRunningNow: isCheckRunning(),
    lastCoverage: state.lastCoverage || null,
    rateLimitedUntil: state.rateLimitedUntil || null,
    sessionStaleFlag: fs.existsSync(path.join(DATA_DIR, 'session-stale.flag')),
    cookies,
    tracked: { routes: routes.length, dates: routes.reduce((n, r) => n + Object.keys(r.dates || {}).length, 0) },
    knownSeats: {
      confirmed: flights.filter(f => f.status === 'confirmed').length,
      waitlist: flights.filter(f => f.status === 'waitlist').length,
    },
  };
}

/** What changed recently: new seats, upgrades, seats gone, mileage changes. Newest first. */
function recentEvents({ sinceHours = 24, limit = 50, from, to } = {}) {
  const route = from && to ? `${airport(from, 'from')}→${airport(to, 'to')}` : null;
  return { sinceHours, ...readEvents({ sinceHours, limit, route }) };
}

module.exports = {
  InputError, TRACK_CABINS, SINGLE_CABINS,
  listTracked, describeTracked, collapseDates, planTrack, track, planUntrack, untrack,
  getFlights, getStatus, recentEvents, isCheckRunning, cabinClassOf,
};
