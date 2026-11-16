/**
 * Tests for src/tracker-api.js and src/events.js — the shared layer under the
 * slash commands and the chat agent. Runs against a scratch data dir.
 * Run: node test/tracker-api.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ana-api-test-'));
process.env.ANA_DATA_DIR = DATA;
delete process.env.ROUTES; // no .env seeding
const api = require('../src/tracker-api');
const { recordEvent, readEvents } = require('../src/events');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.stack}`); process.exitCode = 1; }
}
/** ISO date n days from today — always past ANA's 96h booking window when n >= 10. */
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const reset = () => { for (const f of fs.readdirSync(DATA)) fs.rmSync(path.join(DATA, f), { force: true }); };
const routes = () => JSON.parse(fs.readFileSync(path.join(DATA, 'routes.json'), 'utf8')).routes;
const writeState = (s) => fs.writeFileSync(path.join(DATA, 'state.json'), JSON.stringify(s));
const readState = () => JSON.parse(fs.readFileSync(path.join(DATA, 'state.json'), 'utf8'));
const flight = (route, date, num, over = {}) => [`${route}|${date}|${num}`, {
  status: 'confirmed', route, date, flightNumber: num, searchedCabin: 'Business',
  cabinDesc: `${num} Business Class`, miles: 60000, taxUsd: 100, firstSeen: 'x', lastSeen: 'y', ...over,
}];

console.log('track');
test('adds a daily range with the default cabins and reports what changed', () => {
  reset();
  const r = api.track({ from: 'sfo', to: 'tpe', date: day(30), until: day(32) });
  assert.strictEqual(r.route, 'SFO→TPE');
  assert.deepStrictEqual(r.addedDates, [day(30), day(31), day(32)]);
  assert.deepStrictEqual(r.cabins, ['premium-economy', 'business']);
  assert.deepStrictEqual(routes()[0].dates[day(31)], ['premium-economy', 'business']);
});
test('is additive: tracking economy on an existing date keeps the other cabins', () => {
  const r = api.track({ from: 'SFO', to: 'TPE', date: day(30), cabin: 'economy' });
  assert.deepStrictEqual(r.addedDates, []);
  assert.deepStrictEqual(r.widenedDates, [day(30)]);
  assert.deepStrictEqual(routes()[0].dates[day(30)], ['premium-economy', 'economy', 'business']);
});
test('planTrack reports the effect without writing anything', () => {
  const before = fs.readFileSync(path.join(DATA, 'routes.json'), 'utf8');
  const plan = api.planTrack({ from: 'SFO', to: 'TPE', date: day(30), until: day(40), cabin: 'business' });
  assert.strictEqual(plan.dates.length, 11);
  assert.strictEqual(plan.newDates.length, 8); // 3 already tracked
  assert.strictEqual(fs.readFileSync(path.join(DATA, 'routes.json'), 'utf8'), before);
});
test('drops dates inside ANA\'s booking window, and refuses when none are left', () => {
  const r = api.track({ from: 'SFO', to: 'NRT', date: day(1), until: day(12), cabin: 'business' });
  assert.ok(r.skippedTooSoon.includes(day(1)));
  assert.ok(!r.addedDates.includes(day(1)) && r.addedDates.includes(day(12)));
  assert.throws(() => api.track({ from: 'SFO', to: 'NRT', date: day(1) }), api.InputError);
});
test('rejects bad airports, same-airport routes, unknown cabins and unreadable dates', () => {
  assert.throws(() => api.planTrack({ from: 'San Francisco', to: 'TPE', date: day(30) }), api.InputError);
  assert.throws(() => api.planTrack({ from: 'SFO', to: 'SFO', date: day(30) }), api.InputError);
  assert.throws(() => api.planTrack({ from: 'SFO', to: 'TPE', date: day(30), cabin: 'first' }), api.InputError);
  assert.throws(() => api.planTrack({ from: 'SFO', to: 'TPE', date: 'next friday' }), api.InputError);
});

console.log('describeTracked');
test('collapses consecutive days into ranges per cabin set, keeps gaps, and counts explicitly', () => {
  reset();
  api.track({ from: 'SFO', to: 'TPE', date: day(30), until: day(33), cabin: 'business' });
  api.track({ from: 'SFO', to: 'TPE', date: day(35), until: day(36), cabin: 'business' }); // day 34 is a gap
  api.track({ from: 'SFO', to: 'TPE', date: day(40) });                                     // PE + business
  api.track({ from: 'TYO', to: 'TPE', date: day(50), cabin: 'economy' });
  const d = api.describeTracked();
  assert.strictEqual(d.routeCount, 2);
  assert.strictEqual(d.totalDates, 8);
  assert.deepStrictEqual(d.routes[0], {
    route: 'SFO→TPE', dateCount: 7,
    tracked: [
      { cabins: 'business', dates: [`${day(30)} to ${day(33)}`, `${day(35)} to ${day(36)}`] },
      { cabins: 'premium-economy + business', dates: [day(40)] },
    ],
  });
  assert.deepStrictEqual(d.routes[1].tracked, [{ cabins: 'economy', dates: [day(50)] }]);
});
test('date ranges do not bridge month or year ends incorrectly', () => {
  assert.deepStrictEqual(api.collapseDates(['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-03']), ['2026-12-30 to 2027-01-01', '2027-01-03']);
  assert.deepStrictEqual(api.collapseDates(['2028-02-28', '2028-02-29', '2028-03-01']), ['2028-02-28 to 2028-03-01']);
  assert.deepStrictEqual(api.collapseDates([]), []);
});

console.log('untrack');
test('planUntrack sees a whole-route removal, a partial one, and an untracked route', () => {
  reset();
  api.track({ from: 'SFO', to: 'TPE', date: day(30), until: day(34), cabin: 'business' });
  assert.deepStrictEqual(api.planUntrack({ from: 'SFO', to: 'TPE' }).entireRoute, true);
  const some = api.planUntrack({ from: 'SFO', to: 'TPE', date: day(30), until: day(31) });
  assert.strictEqual(some.entireRoute, false);
  assert.deepStrictEqual(some.affectedDates, [day(30), day(31)]);
  assert.strictEqual(api.planUntrack({ from: 'SFO', to: 'TPE', date: day(30), until: day(34) }).entireRoute, true);
  assert.strictEqual(api.planUntrack({ from: 'LAX', to: 'TPE' }).exists, false);
  assert.deepStrictEqual(api.planUntrack({ from: 'SFO', to: 'TPE', date: day(30), cabin: 'economy' }).affectedDates, []);
});
test('removing dates also clears their cached flights and lastChecked, and nothing else', () => {
  writeState({
    flights: Object.fromEntries([flight('SFO→TPE', day(30), 'NH1'), flight('SFO→TPE', day(33), 'NH2'), flight('TPE→SFO', day(30), 'NH3')]),
    lastChecked: { [`SFO→TPE|${day(30)}|Business`]: 1, [`SFO→TPE|${day(33)}|Business`]: 1 },
  });
  const r = api.untrack({ from: 'SFO', to: 'TPE', date: day(30), until: day(31) });
  assert.deepStrictEqual(r.removedDates.sort(), [day(30), day(31)]);
  assert.strictEqual(r.clearedFlights, 1);
  assert.strictEqual(r.remainingDates, 3);
  assert.deepStrictEqual(Object.keys(readState().flights).sort(), [`SFO→TPE|${day(33)}|NH2`, `TPE→SFO|${day(30)}|NH3`].sort());
  assert.deepStrictEqual(Object.keys(readState().lastChecked), [`SFO→TPE|${day(33)}|Business`]);
});
test('a month (YYYY-MM) removes every tracked date in it, not just the weekly sample', () => {
  reset();
  // Three consecutive days that share one month, far enough out to be bookable.
  const base = new Date(Date.now() + 70 * 86400000); base.setUTCDate(10);
  const iso = (n) => new Date(base.getTime() + n * 86400000).toISOString().slice(0, 10);
  api.track({ from: 'SFO', to: 'TPE', date: iso(0), until: iso(2), cabin: 'business' });
  api.track({ from: 'SFO', to: 'TPE', date: day(150), cabin: 'business' });
  writeState({ flights: Object.fromEntries([flight('SFO→TPE', iso(1), 'NH1')]) });
  const r = api.untrack({ from: 'SFO', to: 'TPE', date: iso(0).slice(0, 7) });
  assert.deepStrictEqual(r.removedDates.sort(), [iso(0), iso(1), iso(2)]);
  assert.strictEqual(r.clearedFlights, 1);
  assert.strictEqual(r.remainingDates, 1);
});
test('removing one cabin keeps the date; removing the last cabin drops the date', () => {
  reset();
  api.track({ from: 'SFO', to: 'TPE', date: day(30) }); // PE + business
  let r = api.untrack({ from: 'SFO', to: 'TPE', date: day(30), cabin: 'business' });
  assert.deepStrictEqual(r.updatedDates, [day(30)]);
  assert.deepStrictEqual(routes()[0].dates[day(30)], ['premium-economy']);
  r = api.untrack({ from: 'SFO', to: 'TPE', date: day(30), cabin: 'premium-economy' });
  assert.strictEqual(r.removedEntireRoute, true);
});
test('an untracked route reports removed:false; a bad range throws the slash-command wording', () => {
  assert.strictEqual(api.untrack({ from: 'LAX', to: 'TPE' }).removed, false);
  assert.throws(() => api.untrack({ from: 'SFO', to: 'TPE', date: 'nope', until: day(3) }), /Invalid date range: `nope` to/);
  assert.throws(() => api.untrack({ from: 'SFO', to: 'TPE', date: 'nope' }), /Invalid date format: `nope`/);
});

console.log('getFlights');
test('filters by route end, date window, cabin class, waitlist and miles', () => {
  reset();
  writeState({ lastCheck: '2026-01-01T00:00:00Z', flights: Object.fromEntries([
    flight('SFO→TYO', '2026-12-05', 'NH7', { miles: 55000 }),
    flight('SFO→TYO', '2026-12-06', 'NH107', { miles: 36000, cabinDesc: 'NH107 Premium Economy Class', searchedCabin: 'Premium Economy' }),
    flight('SFO→TYO', '2026-12-07', 'NH8', { status: 'waitlist' }),
    flight('SFO→TPE', '2026-12-06', 'NH7+NH851', { miles: 86500, cabinDesc: 'NH7 Economy Class + NH851 Economy Class', searchedCabin: 'Economy' }),
  ]) });
  assert.strictEqual(api.getFlights().count, 3); // confirmed only by default
  assert.strictEqual(api.getFlights({ includeWaitlist: true }).count, 4);
  assert.deepStrictEqual(api.getFlights({ to: 'tyo' }).flights.map(f => f.flight), ['NH7', 'NH107']);
  assert.deepStrictEqual(api.getFlights({ maxMiles: 60000 }).flights.map(f => f.miles), [55000, 36000]);
  assert.deepStrictEqual(api.getFlights({ dateFrom: '2026-12-06', dateTo: '2026-12-06' }).flights.map(f => f.route), ['SFO→TPE', 'SFO→TYO']);
  // "economy" must not match "premium economy"
  assert.deepStrictEqual(api.getFlights({ cabin: 'economy' }).flights.map(f => f.flight), ['NH7+NH851']);
  assert.deepStrictEqual(api.getFlights({ cabin: 'premium-economy' }).flights.map(f => f.cabin), ['Premium Economy']);
  assert.strictEqual(api.getFlights().lastCheck, '2026-01-01T00:00:00Z');
  assert.throws(() => api.getFlights({ dateFrom: 'Dec 6' }), api.InputError);
});
test('caps the list and says how many were left out', () => {
  const r = api.getFlights({ limit: 2 });
  assert.strictEqual(r.flights.length, 2);
  assert.strictEqual(r.truncated, 1);
});

console.log('getStatus');
test('reports coverage, cookie health by cookie name, the stale flag and totals', () => {
  reset();
  api.track({ from: 'SFO', to: 'TPE', date: day(30), until: day(31) });
  writeState({ lastCheck: 't', lastCoverage: { checked: 44, total: 44 }, flights: Object.fromEntries([flight('SFO→TPE', day(30), 'NH1'), flight('SFO→TPE', day(31), 'NH2', { status: 'waitlist' })]) });
  fs.writeFileSync(path.join(DATA, 'cookies.json'), JSON.stringify([{ name: 'personal' }, { name: 'other' }]));
  let s = api.getStatus();
  assert.deepStrictEqual(s.lastCoverage, { checked: 44, total: 44 });
  assert.deepStrictEqual(s.cookies, { present: true, hasPersonal: true, hasAbck: false });
  assert.deepStrictEqual(s.tracked, { routes: 1, dates: 2 });
  assert.deepStrictEqual(s.knownSeats, { confirmed: 1, waitlist: 1 });
  assert.strictEqual(s.sessionStaleFlag, false);
  assert.strictEqual(s.checkRunningNow, false);
  fs.writeFileSync(path.join(DATA, 'session-stale.flag'), '{}');
  fs.writeFileSync(path.join(DATA, 'run.lock'), String(process.pid));
  s = api.getStatus();
  assert.strictEqual(s.sessionStaleFlag, true);
  assert.strictEqual(s.checkRunningNow, true);
});
test('a lock left by a dead process does not count as a running check', () => {
  fs.writeFileSync(path.join(DATA, 'run.lock'), '999999999');
  assert.strictEqual(api.isCheckRunning(), false);
});

console.log('events');
test('records events and reads them newest-first, filtered by age and route', () => {
  reset();
  recordEvent('new', { route: 'SFO→TPE', date: '2026-12-06', flightNumber: 'NH7', cabinDesc: 'Business', status: 'confirmed', miles: 60000, taxUsd: 100 });
  recordEvent('miles_changed', { route: 'SFO→TYO', date: '2026-12-06', flightNumber: 'NH107', miles: 36000 }, { prevMiles: 52500 });
  fs.appendFileSync(path.join(DATA, 'events.jsonl'), '{"ts":"2020-01-01T00:00:00Z","type":"gone","route":"SFO→TPE"}\n{torn line\n');
  const all = readEvents({ sinceHours: 24 });
  assert.deepStrictEqual(all.events.map(e => e.type), ['miles_changed', 'new']);
  assert.strictEqual(all.events[0].prevMiles, 52500);
  assert.strictEqual(readEvents({ sinceHours: 24 * 365 * 20 }).total, 3);
  assert.deepStrictEqual(api.recentEvents({ from: 'sfo', to: 'tpe' }).events.map(e => e.flightNumber), ['NH7']);
  assert.strictEqual(readEvents({ limit: 1 }).events.length, 1);
  assert.strictEqual(readEvents({ limit: 1 }).total, 2);
});
test('no event file yet reads as empty', () => {
  reset();
  assert.deepStrictEqual(readEvents(), { events: [], total: 0 });
});

fs.rmSync(DATA, { recursive: true, force: true });
console.log(`\n${passed} passed`);
