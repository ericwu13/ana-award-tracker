/**
 * Tests for state-maintenance in src/index.js:
 *   - detectGoneFlights: grace period that stops oscillating waitlist seats
 *     from being deleted-and-re-alerted every cycle (the notification-spam bug).
 *   - pruneStaleFlights: orphan + age-based cleanup that keeps state.json from
 *     growing unbounded.
 *
 * Run:  node test/gone-detection.test.js
 */

// Require index.js WITHOUT launching a real search cycle, and neutralise the
// credential guard + Discord token so requiring it is inert (no network).
process.env.ANA_INDEX_NOAUTORUN = '1';
process.env.ANA_USERNAME = 'test';
process.env.ANA_PASSWORD = 'test';
process.env.DISCORD_BOT_TOKEN = ''; // dotenv won't override an already-set key → no real sends
process.env.GONE_GRACE_MISSES = '3'; // pin explicitly (matches the production default)

const assert = require('assert');
const { detectGoneFlights, pruneStaleFlights } = require('../src/index.js');

let passed = 0, failed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}`); console.log(`    ${e.message}`); failed++; failures.push(name); }
}

const ROUTE = 'HND→SFO', DATE = '2027-01-01', CABIN = 'premium-economy';
const KEY = `${ROUTE}|${DATE}|NH108`;
const waitlistSeat = (extra = {}) => ({ status: 'waitlist', route: ROUTE, date: DATE, searchedCabin: CABIN, flightNumber: 'NH108', ...extra });
// An allResults entry that marks this combo as "searched" this cycle.
const searched = [{ route: ROUTE, date: DATE, cabin: CABIN, results: [{ flightNumber: 'NH999' }] }];

(async () => {
  console.log('\ndetectGoneFlights — waitlist oscillation grace period (GONE_GRACE_MISSES=3)');

  await test('misses below the threshold keep the seat (holds through flickers)', async () => {
    const state = { flights: { [KEY]: waitlistSeat() } };
    await detectGoneFlights(searched, state, new Set()); // miss 1/3
    assert.strictEqual(state.flights[KEY].missed, 1);
    await detectGoneFlights(searched, state, new Set()); // miss 2/3
    assert.ok(state.flights[KEY], 'still held after 2 misses');
    assert.strictEqual(state.flights[KEY].missed, 2);
  });

  await test('reaching GONE_GRACE_MISSES consecutive misses deletes it', async () => {
    const state = { flights: { [KEY]: waitlistSeat({ missed: 2 }) } };
    await detectGoneFlights(searched, state, new Set()); // miss 3/3
    assert.ok(!state.flights[KEY], 'removed after 3 consecutive misses');
  });

  await test('reappearing after misses clears the streak (no re-alert)', async () => {
    const state = { flights: { [KEY]: waitlistSeat({ missed: 2 }) } };
    await detectGoneFlights(searched, state, new Set([KEY])); // seen again this cycle
    assert.ok(state.flights[KEY], 'seat retained');
    assert.strictEqual(state.flights[KEY].missed, 0, 'miss streak reset to 0');
  });

  await test('combo not searched → seat untouched (partial coverage is safe)', async () => {
    const state = { flights: { [KEY]: waitlistSeat() } };
    await detectGoneFlights([], state, new Set()); // nothing searched this cycle
    assert.ok(state.flights[KEY], 'seat retained when its combo was not searched');
    assert.strictEqual(state.flights[KEY].missed, undefined, 'no miss counted for un-searched combo');
  });

  await test('full oscillation: present → flicker → present never deletes', async () => {
    const state = { flights: { [KEY]: waitlistSeat() } };
    await detectGoneFlights(searched, state, new Set([KEY])); // cycle 1: present
    await detectGoneFlights(searched, state, new Set());      // cycle 2: flicker out (miss 1)
    await detectGoneFlights(searched, state, new Set([KEY])); // cycle 3: back
    assert.ok(state.flights[KEY], 'seat retained across the whole oscillation');
    assert.strictEqual(state.flights[KEY].missed, 0);
  });

  console.log('\npruneStaleFlights — orphan + age-based state cleanup');

  const NOW = Date.parse('2026-08-08T12:00:00Z');
  const routes = [{ from: 'HND', to: 'SFO', dates: { '2026-12-29': ['premium-economy'] } }];

  await test('removes flights whose route/date is no longer tracked (orphan)', () => {
    const state = { flights: {
      'HND→SFO|2026-12-29|NH108': { lastSeen: '2026-08-08T00:00:00Z' }, // tracked, fresh
      'HND→SFO|2026-05-08|NH108': { lastSeen: '2026-04-21T00:00:00Z' }, // untracked date
    } };
    const res = pruneStaleFlights(state, routes, { now: NOW });
    assert.strictEqual(res.orphaned, 1);
    assert.ok(state.flights['HND→SFO|2026-12-29|NH108'], 'tracked seat kept');
    assert.ok(!state.flights['HND→SFO|2026-05-08|NH108'], 'orphaned seat removed');
  });

  await test('removes tracked-but-stale flights (lastSeen older than maxAgeDays)', () => {
    const state = { flights: {
      'HND→SFO|2026-12-29|NH108': { lastSeen: '2026-06-01T00:00:00Z' }, // 68 days stale
    } };
    const res = pruneStaleFlights(state, routes, { maxAgeDays: 30, now: NOW });
    assert.strictEqual(res.stale, 1);
    assert.ok(!state.flights['HND→SFO|2026-12-29|NH108'], 'stale seat removed');
  });

  await test('keeps tracked, recently-seen flights', () => {
    const state = { flights: {
      'HND→SFO|2026-12-29|NH108': { lastSeen: '2026-08-07T00:00:00Z' }, // 1 day old
    } };
    const res = pruneStaleFlights(state, routes, { maxAgeDays: 30, now: NOW });
    assert.deepStrictEqual([res.orphaned, res.stale], [0, 0]);
    assert.ok(state.flights['HND→SFO|2026-12-29|NH108'], 'fresh tracked seat kept');
  });

  console.log(`\n${'='.repeat(60)}`);
  console.log(`${passed + failed} tests, ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
})();
