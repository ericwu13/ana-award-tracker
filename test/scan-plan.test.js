/**
 * Tests for scan-then-confirm:
 *   - src/sources/seats-aero.js  row mapping, window grouping, fetch + fallback
 *   - src/scan-plan.js           which tasks still go to ANA, and why
 *   - src/sources/index.js       source/program tagging
 *
 * Run:  node test/scan-plan.test.js
 */
process.env.SEATS_AERO_API_KEY = 'test-key';
delete process.env.SEATS_AERO_SOURCES;
delete process.env.SEATS_AERO_AIRLINES;

const assert = require('assert');
const seatsAero = require('../src/sources/seats-aero');
const { planConfirmations, priorityLastChecked } = require('../src/scan-plan');
const { tagResults } = require('../src/sources');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

const NOW = Date.parse('2026-11-21T12:00:00Z');
const fresh = '2026-11-21T06:00:00Z';
const row = (o = {}) => ({
  Date: '2027-03-01', Source: 'aeroplan', UpdatedAt: fresh,
  Route: { OriginAirport: 'HND', DestinationAirport: 'SFO' },
  JAvailable: true, JMileageCost: '75000', JRemainingSeats: 2, JAirlines: 'NH', JDirect: true,
  YAvailable: false, YAirlines: '',
  ...o,
});
const task = (date, cabinKey = 'business', o = {}) => ({
  from: 'HND', to: 'SFO', date, cabinKey,
  cabinName: { business: 'Business', economy: 'Economy', 'premium-economy': 'Premium Economy' }[cabinKey],
  ...o,
});

(async () => {
  console.log('\nseats-aero rowToEntry');
  const cfg = seatsAero.config();

  await test('maps a business row with source/program tags', () => {
    const e = seatsAero.rowToEntry(row(), 'business', cfg, NOW);
    assert.strictEqual(e.available, true);
    assert.strictEqual(e.source, 'seats.aero');
    assert.strictEqual(e.program, 'aeroplan');
    assert.strictEqual(e.miles, 75000);
    assert.deepStrictEqual(e.airlines, ['NH']);
    assert.strictEqual(e.date, '2027-03-01');
  });
  await test('non-Star-Alliance-only space is not a hit', () => {
    assert.strictEqual(seatsAero.rowToEntry(row({ JAirlines: 'EY, EK' }), 'business', cfg, NOW).available, false);
  });
  await test('mixed carriers with one Star member is a hit', () => {
    assert.strictEqual(seatsAero.rowToEntry(row({ JAirlines: 'EK, UA' }), 'business', cfg, NOW).available, true);
  });
  await test('stale row (older than SEATS_AERO_MAX_AGE_HOURS) is not a hit', () => {
    const e = seatsAero.rowToEntry(row({ UpdatedAt: '2026-11-15T00:00:00Z' }), 'business', cfg, NOW);
    assert.strictEqual(e.available, false);
    assert.strictEqual(e.stale, true);
  });
  await test('reads the prefix for the asked cabin (economy = Y)', () => {
    assert.strictEqual(seatsAero.rowToEntry(row(), 'economy', cfg, NOW).available, false);
  });

  console.log('\nseats-aero groupTasks / search');
  await test('one window per route+cabin spanning min..max date', () => {
    const g = seatsAero.groupTasks([task('2027-03-09'), task('2027-03-01'), task('2027-03-05', 'economy')]);
    assert.strictEqual(g.length, 2);
    const biz = g.find(x => x.cabinKey === 'business');
    assert.strictEqual(biz.startDate, '2027-03-01');
    assert.strictEqual(biz.endDate, '2027-03-09');
  });
  await test('search follows the cursor, keeps only asked dates, sends auth header', async () => {
    const calls = [];
    const pages = [
      { data: [row({ Date: '2027-03-01' }), row({ Date: '2027-03-02' })], hasMore: true, cursor: 'c1' },
      { data: [row({ Date: '2027-03-09', Source: 'united' })], hasMore: false },
    ];
    const fetchImpl = async (url, init) => { calls.push({ url, init }); return { ok: true, json: async () => pages[calls.length - 1] }; };
    const r = await seatsAero.search([task('2027-03-01'), task('2027-03-09')], { fetchImpl, now: NOW });
    assert.strictEqual(calls.length, 2);
    assert.ok(calls[1].url.includes('cursor=c1'));
    assert.strictEqual(calls[0].init.headers['Partner-Authorization'], 'test-key');
    assert.deepStrictEqual(r.entries.map(e => `${e.date}:${e.program}`), ['2027-03-01:aeroplan', '2027-03-09:united']);
    assert.strictEqual(r.errors.length, 0);
    assert.strictEqual(r.scannedGroups.length, 1);
  });
  await test('HTTP error → window reported in errors, not in scannedGroups', async () => {
    const r = await seatsAero.search([task('2027-03-01')], { fetchImpl: async () => ({ ok: false, status: 429 }), now: NOW });
    assert.strictEqual(r.scannedGroups.length, 0);
    assert.ok(/429/.test(r.errors[0]));
  });

  console.log('\nplanConfirmations');
  const scanOf = (tasks, entries) => ({ entries, scannedGroups: seatsAero.groupTasks(tasks) });
  const hit = (date, cabinKey = 'business') => ({ from: 'HND', to: 'SFO', date, cabinKey, available: true, program: 'aeroplan', miles: 75000, airlines: ['NH'] });
  const recent = { 'HND→SFO|2027-03-01|Business': NOW - 3600000, 'HND→SFO|2027-03-02|Business': NOW - 3600000 };

  await test('default: scan miss is still searched (seats.aero cannot see ANA-member space)', () => {
    const ts = [task('2027-03-01'), task('2027-03-02')];
    const p = planConfirmations(ts, scanOf(ts, [hit('2027-03-01')]), { lastChecked: recent }, { now: NOW });
    assert.deepStrictEqual(p.confirm.map(d => [d.task.date, d.reason, d.priority]),
      [['2027-03-01', 'scan-hit', true], ['2027-03-02', 'scan-miss', false]]);
    assert.strictEqual(p.skip.length, 0);
  });
  await test('opt-in SCAN_MISS_RECHECK_HOURS throttles only recently-checked misses', () => {
    const ts = [task('2027-03-02'), task('2027-03-03')]; // 03-03 never checked
    const p = planConfirmations(ts, scanOf(ts, []), { lastChecked: recent }, { now: NOW, missRecheckHours: 6 });
    assert.deepStrictEqual(p.skip.map(d => d.task.date), ['2027-03-02']);
    assert.deepStrictEqual(p.confirm.map(d => d.task.date), ['2027-03-03']);
    assert.strictEqual(p.counts['scan-miss-skipped'], 1);
  });
  await test('premium-economy is untrusted by default → searched, no priority', () => {
    const ts = [task('2027-03-01', 'premium-economy')];
    const p = planConfirmations(ts, scanOf(ts, []), {}, { now: NOW, missRecheckHours: 6 });
    assert.strictEqual(p.confirm[0].reason, 'untrusted-cabin');
  });
  await test('window that failed to scan → searched (fallback = old behaviour)', () => {
    const ts = [task('2027-03-01')];
    const p = planConfirmations(ts, { entries: [], scannedGroups: [] }, { lastChecked: recent }, { now: NOW, missRecheckHours: 6 });
    assert.strictEqual(p.confirm[0].reason, 'scan-failed');
  });
  await test('combo with a tracked seat is never throttled (GONE detection)', () => {
    const ts = [task('2027-03-02')];
    const state = { lastChecked: recent, flights: { k: { route: 'HND→SFO', date: '2027-03-02', searchedCabin: 'Business' } } };
    const p = planConfirmations(ts, scanOf(ts, []), state, { now: NOW, missRecheckHours: 6 });
    assert.strictEqual(p.confirm[0].reason, 'tracked');
  });
  await test('unavailable scan entries are not hits', () => {
    const ts = [task('2027-03-01')];
    const p = planConfirmations(ts, scanOf(ts, [{ ...hit('2027-03-01'), available: false }]), { lastChecked: recent }, { now: NOW });
    assert.strictEqual(p.confirm[0].reason, 'scan-miss');
  });
  await test('priorityLastChecked puts hits first without touching real state', () => {
    const ts = [task('2027-03-01'), task('2027-03-02')];
    const p = planConfirmations(ts, scanOf(ts, [hit('2027-03-02')]), { lastChecked: recent }, { now: NOW });
    const order = priorityLastChecked(recent, p);
    assert.strictEqual(order['HND→SFO|2027-03-02|Business'], -1);
    assert.strictEqual(order['HND→SFO|2027-03-01|Business'], recent['HND→SFO|2027-03-01|Business']);
    assert.notStrictEqual(recent['HND→SFO|2027-03-02|Business'], -1);
  });

  console.log('\ntagResults');
  await test('tags missing fields, keeps existing ones', () => {
    const rs = tagResults([{ flightNumber: 'NH108' }, { program: 'x' }], { source: 'ana', program: 'ana-amc' });
    assert.deepStrictEqual(rs.map(r => [r.source, r.program]), [['ana', 'ana-amc'], ['ana', 'x']]);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
