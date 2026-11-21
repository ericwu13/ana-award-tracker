/**
 * seats.aero tracking: row parsing, queries, budget pacing, saver filter,
 * dedup / grace, a full cycle with a fake API, route options, embed.
 * Run: node test/seats-watch.test.js
 */
const assert = require('assert');
const api = require('../src/sources/seats-aero');
const w = require('../src/seats-watch');
const { runSeatsCycle, emptyState } = require('../src/seats-run');
const { applyRouteOptions, routeSources, usesSource, parseProgramList } = require('../src/routes');
const { buildSeatsAeroEmbed } = require('../src/notifier');

let passed = 0, failed = 0;
const pending = [];
function test(name, fn) {
  const done = () => { passed++; console.log(`  ✓ ${name}`); };
  const fail = e => { failed++; console.log(`  ✗ ${name}\n    ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n    ') : e}`); };
  try {
    const r = fn();
    if (r && typeof r.then === 'function') pending.push(r.then(done, fail));
    else done();
  } catch (e) { fail(e); }
}

const NOW = Date.parse('2026-11-21T12:00:00Z');
const row = (o = {}) => ({
  ID: 'a1', Date: '2026-12-10', Source: 'aeroplan',
  Route: { OriginAirport: 'TPE', DestinationAirport: 'SFO' },
  JAvailable: true, JMileageCost: '75000', JRemainingSeats: 2, JAirlines: 'BR, UA', JDirect: true,
  YAvailable: false, YMileageCost: '0',
  ...o,
});
const route = (o = {}) => ({ from: 'TPE', to: 'SFO', dates: { '2026-12-10': ['business'], '2026-12-12': ['economy', 'business'] }, ...o });

console.log('\nrowToEntries');
test('reads available cabins only, miles as number, airlines split', () => {
  const es = api.rowToEntries(row());
  assert.strictEqual(es.length, 1);
  assert.deepStrictEqual(
    { ...es[0], updatedAt: undefined },
    { id: 'a1', program: 'aeroplan', from: 'TPE', to: 'SFO', date: '2026-12-10', cabinKey: 'business', miles: 75000, seats: 2, airlines: ['BR', 'UA'], direct: true, taxes: null, taxesCurrency: null, updatedAt: undefined });
});
test('premium economy uses W prefix; numeric MileageCost accepted', () => {
  const es = api.rowToEntries(row({ JAvailable: false, WAvailable: true, WMileageCost: 55000 }));
  assert.strictEqual(es[0].cabinKey, 'premium-economy');
  assert.strictEqual(es[0].miles, 55000);
});
test('available without a price, or a broken row, yields nothing', () => {
  assert.deepStrictEqual(api.rowToEntries(row({ JMileageCost: '' })), []);
  assert.deepStrictEqual(api.rowToEntries({ Date: 'x' }), []);
  assert.deepStrictEqual(api.rowToEntries(null), []);
});
test('rowsOf accepts {data:[]} or a bare array', () => {
  assert.strictEqual(api.rowsOf({ data: [1, 2] }).length, 2);
  assert.strictEqual(api.rowsOf([1]).length, 1);
  assert.deepStrictEqual(api.rowsOf({}), []);
});

console.log('\nqueries + filtering');
test('one query per seats.aero route, date window, expired dates dropped', () => {
  const qs = w.buildQueries([route(), route({ from: 'HND', sources: ['ana'] })], { usesSource, minDate: '2026-12-11' });
  assert.strictEqual(qs.length, 1);
  assert.strictEqual(qs[0].startDate, '2026-12-12');
  assert.strictEqual(qs[0].endDate, '2026-12-12');
});
test('filterEntries keeps tracked (date, cabin), program list and direct-only', () => {
  const q = w.buildQueries([route({ programs: ['united'], directOnly: true })], { usesSource })[0];
  const es = [
    { from: 'TPE', to: 'SFO', date: '2026-12-10', cabinKey: 'business', program: 'united', direct: true },
    { from: 'TPE', to: 'SFO', date: '2026-12-10', cabinKey: 'economy', program: 'united', direct: true }, // cabin not tracked that day
    { from: 'TPE', to: 'SFO', date: '2026-12-10', cabinKey: 'business', program: 'aeroplan', direct: true }, // program filtered
    { from: 'TPE', to: 'SFO', date: '2026-12-12', cabinKey: 'economy', program: 'united', direct: false }, // not direct
    { from: 'TPE', to: 'LAX', date: '2026-12-10', cabinKey: 'business', program: 'united', direct: true }, // other route
  ];
  assert.strictEqual(w.filterEntries(es, q).length, 1);
});

console.log('\nbudget pacing');
test('interval stretches to fit the daily budget', () => {
  const p = w.planRun({ now: NOW, lastRunAt: null, intervalMin: 30, budget: 900, usage: null, estCalls: 20 });
  assert.strictEqual(p.run, true);
  assert.strictEqual(p.effectiveIntervalMin, 32); // 1440*20/900
});
test('too soon → skip; within 2 min slack → run', () => {
  const at = m => new Date(NOW - m * 60000).toISOString();
  assert.strictEqual(w.planRun({ now: NOW, lastRunAt: at(10), intervalMin: 30, budget: 900, estCalls: 1 }).run, false);
  assert.strictEqual(w.planRun({ now: NOW, lastRunAt: at(29), intervalMin: 30, budget: 900, estCalls: 1 }).run, true);
});
test('budget exhausted today → skip; new UTC day resets', () => {
  assert.strictEqual(w.planRun({ now: NOW, intervalMin: 30, budget: 900, usage: { day: '2026-11-21', calls: 899 }, estCalls: 2 }).run, false);
  assert.strictEqual(w.planRun({ now: NOW, intervalMin: 30, budget: 900, usage: { day: '2026-11-20', calls: 899 }, estCalls: 2 }).run, true);
  assert.deepStrictEqual(w.recordUsage({ day: '2026-11-21', calls: 5 }, NOW, 3), { day: '2026-11-21', calls: 8 });
  assert.deepStrictEqual(w.recordUsage({ day: '2026-11-20', calls: 5 }, NOW, 3), { day: '2026-11-21', calls: 3 });
});

console.log('\nsaver filter');
const e = (miles, o = {}) => ({ program: 'aeroplan', from: 'TPE', to: 'SFO', date: '2026-12-10', cabinKey: 'business', miles, ...o });
test('learning period: min(floor × 1.1, cap)', () => {
  const h = w.updateHistory({}, [e(70000)], NOW);
  assert.deepStrictEqual(w.saverLimit(e(70000), h), { limit: 77000, rule: 'learning' });
  const h2 = w.updateHistory({}, [e(100000)], NOW);
  assert.strictEqual(w.saverLimit(e(100000), h2).limit, 85000); // cap wins → expensive first sighting never alerts
});
test('after 7 days: floor × 1.1 with hard ceiling cap × 1.5', () => {
  const h = {};
  for (let d = 0; d < 7; d++) w.updateHistory(h, [e(60000 + d * 1000)], NOW - d * 86400000);
  assert.deepStrictEqual(w.saverLimit(e(90000), h), { limit: 66000, rule: 'saver' });
  const pricey = {};
  for (let d = 0; d < 7; d++) w.updateHistory(pricey, [e(300000)], NOW - d * 86400000);
  assert.strictEqual(w.saverLimit(e(300000), pricey).limit, 127500); // 85k × 1.5
});
test('route max-miles overrides the learned limit', () => {
  assert.deepStrictEqual(w.saverLimit(e(90000), {}, { maxMiles: { business: 95000 } }), { limit: 95000, rule: 'max-miles' });
});
test('history keeps one low per day and forgets >30 days', () => {
  const h = {};
  w.updateHistory(h, [e(80000), e(70000)], NOW);
  w.updateHistory(h, [e(50000)], NOW - 31 * 86400000);
  w.updateHistory(h, [], NOW);
  assert.deepStrictEqual(h[w.priceKey(e(1))], { '2026-11-21': 70000 });
});

console.log('\ndedup + grace');
const q = w.buildQueries([route()], { usesSource })[0];
test('new → alert once; same price → silent; lower → price-drop', () => {
  const st = {}, h = {};
  const scan = m => { const s = [e(m)]; w.updateHistory(h, s, NOW); return w.applyScan(st, s, q, h, { now: NOW }); };
  assert.strictEqual(scan(70000).alerts[0].reason, 'new');
  assert.strictEqual(scan(70000).alerts.length, 0);
  const drop = scan(65000).alerts[0];
  assert.strictEqual(drop.reason, 'price-drop');
  assert.strictEqual(drop.previousMiles, 70000);
});
test('over the limit → tracked but no alert', () => {
  const st = {}, h = {};
  const s = [e(120000)];
  w.updateHistory(h, s, NOW);
  assert.strictEqual(w.applyScan(st, s, q, h, { now: NOW }).alerts.length, 0);
  assert.strictEqual(Object.values(st)[0].qualifies, false);
});
test('missing for 3 scans → removed; reappearing resets misses', () => {
  const st = {}, h = {};
  w.updateHistory(h, [e(70000)], NOW);
  w.applyScan(st, [e(70000)], q, h, { now: NOW });
  w.applyScan(st, [], q, h, { now: NOW });
  w.applyScan(st, [e(70000)], q, h, { now: NOW });
  assert.strictEqual(Object.values(st)[0].misses, 0);
  for (let i = 0; i < 2; i++) w.applyScan(st, [], q, h, { now: NOW });
  assert.strictEqual(Object.keys(st).length, 1);
  assert.deepStrictEqual(w.applyScan(st, [], q, h, { now: NOW }).removed.length, 1);
  assert.strictEqual(Object.keys(st).length, 0);
});
test('pruneUntracked drops entries for untracked route/date/cabin', () => {
  const st = { a: { route: 'TPE→SFO', date: '2026-12-10', cabinKey: 'business' }, b: { route: 'TPE→SFO', date: '2026-12-10', cabinKey: 'economy' }, c: { route: 'X→Y', date: '2026-12-10', cabinKey: 'business' } };
  assert.strictEqual(w.pruneUntracked(st, [q]), 2);
  assert.deepStrictEqual(Object.keys(st), ['a']);
});
test('groupAlerts: one group per route+date+cabin, cheapest first', () => {
  const gs = w.groupAlerts([{ entry: e(80000, { program: 'united' }) }, { entry: e(70000) }, { entry: e(30000, { cabinKey: 'economy' }) }]);
  assert.strictEqual(gs.length, 2);
  const biz = gs.find(g => g.cabinKey === 'business');
  assert.deepStrictEqual(biz.items.map(i => i.entry.program), ['aeroplan', 'united']);
});

console.log('\nfull cycle (fake API)');
function fakeFetch(pages, calls = []) {
  return async (url, opts) => {
    calls.push({ url, key: opts.headers['Partner-Authorization'] });
    const p = pages.shift();
    if (p && p.status) return { ok: false, status: p.status, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => p };
  };
}
const env = { SEATS_AERO_API_KEY: 'k' };
test('follows moreURL, dedupes by ID, alerts grouped, saves state', async () => {
  const calls = [];
  const pages = [
    { data: [row(), row({ ID: 'a2', Source: 'united', JMileageCost: '80000' })], hasMore: true, moreURL: '/partnerapi/search?cursor=2' },
    { data: [row(), row({ ID: 'a3', Date: '2026-12-12', YAvailable: true, YMileageCost: '35000', JAvailable: false })], hasMore: false },
  ];
  const sent = [];
  let saved = null;
  const res = await runSeatsCycle({ env, now: NOW, routes: [route()], usesSource, state: emptyState(), saveState: s => { saved = s; }, fetchImpl: fakeFetch(pages, calls), notify: async g => { sent.push(g); return true; } });
  assert.strictEqual(calls.length, 2);
  assert.ok(calls[1].url.endsWith('/partnerapi/search?cursor=2'));
  assert.strictEqual(calls[0].key, 'k');
  assert.strictEqual(res.alerts, 2); // biz group (aeroplan+united) + eco group
  assert.strictEqual(sent.find(g => g.cabinKey === 'business').items.length, 2);
  assert.strictEqual(saved.usage.calls, 2);
  assert.strictEqual(saved.lastCallsPerCycle, 2);
});
test('no key → skipped without any call', async () => {
  const r = await runSeatsCycle({ env: {}, routes: [route()], usesSource, state: emptyState(), fetchImpl: () => { throw new Error('called'); } });
  assert.match(r.skipped, /API_KEY/);
});
test('401 → status alert once per 6 h, entries untouched', async () => {
  const st = emptyState();
  st.entries.x = { route: 'TPE→SFO', date: '2026-12-10', cabinKey: 'business', program: 'aeroplan' };
  const alerts = [];
  await runSeatsCycle({ env, now: NOW, force: true, routes: [route()], usesSource, state: st, fetchImpl: fakeFetch([{ status: 401 }]), sendAlert: async m => alerts.push(m) });
  await runSeatsCycle({ env, now: NOW + 60000, force: true, routes: [route()], usesSource, state: st, fetchImpl: fakeFetch([{ status: 401 }]), sendAlert: async m => alerts.push(m) });
  assert.strictEqual(alerts.length, 1);
  assert.ok(st.entries.x);
  assert.strictEqual(st.entries.x.misses, undefined);
});
test('500 on a route → error recorded, no GONE judgement for it', async () => {
  const st = emptyState();
  st.entries.x = { route: 'TPE→SFO', date: '2026-12-10', cabinKey: 'business', program: 'aeroplan', misses: 0 };
  const r = await runSeatsCycle({ env, now: NOW, routes: [route()], usesSource, state: st, fetchImpl: fakeFetch([{ status: 500 }]) });
  assert.strictEqual(r.errors.length, 1);
  assert.strictEqual(st.entries.x.misses, 0);
});

console.log('\nroute options');
test('defaults: both sources', () => {
  assert.deepStrictEqual(routeSources({}), ['ana', 'seats.aero']);
  assert.strictEqual(usesSource({ sources: ['ana'] }, 'seats.aero'), false);
});
test('applyRouteOptions sets and clears fields', () => {
  const r = {};
  applyRouteOptions(r, { source: 'seats.aero', programs: 'Aeroplan, united', maxMiles: 70000, cabinKeys: ['business'], directOnly: true });
  assert.deepStrictEqual(r, { sources: ['seats.aero'], programs: ['aeroplan', 'united'], maxMiles: { business: 70000 }, directOnly: true });
  applyRouteOptions(r, { programs: 'all', maxMiles: 0, cabinKeys: ['business'], directOnly: false });
  assert.deepStrictEqual(r, { sources: ['seats.aero'] });
  assert.deepStrictEqual(parseProgramList(''), []);
});

console.log('\nembed');
test('lists programs cheapest first with drop marker', () => {
  const emb = buildSeatsAeroEmbed({ route: 'TPE→SFO', date: '2026-12-10', cabinKey: 'business', items: [
    { entry: { ...e(70000), airlines: ['BR'], direct: true, seats: 2 }, reason: 'price-drop', previousMiles: 80000 },
    { entry: { ...e(80000, { program: 'united' }), airlines: [], direct: null, seats: null }, reason: 'new' },
  ] });
  assert.match(emb.title, /Business saver — TPE → SFO/);
  assert.match(emb.description, /\*\*Aeroplan\*\* — 70,000 mi · BR · direct · 2 seats ⬇️ was 80,000/);
  assert.match(emb.description, /United MileagePlus\*\* — 80,000 mi$/);
});

Promise.all(pending).then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
});
