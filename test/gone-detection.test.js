/**
 * Tests for GONE detection's grace period — src/index.js:detectGoneFlights.
 *
 * Reproduces ANA's waitlist oscillation (a seat that flickers out for a cycle
 * and comes back) to prove the fix: a brief miss no longer deletes the state
 * entry, so the seat is NOT re-alerted as "new" when it reappears. Regression
 * guard for the every-cycle notification spam bug.
 *
 * Run:  node test/gone-detection.test.js
 */

// Require index.js WITHOUT launching a real search cycle, and neutralise the
// credential guard + Discord token so requiring it is inert (no network).
process.env.ANA_INDEX_NOAUTORUN = '1';
process.env.ANA_USERNAME = 'test';
process.env.ANA_PASSWORD = 'test';
process.env.DISCORD_BOT_TOKEN = ''; // dotenv won't override an already-set key → no real sends
process.env.GONE_GRACE_MISSES = '2';

const assert = require('assert');
const { detectGoneFlights } = require('../src/index.js');

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
  console.log('\ndetectGoneFlights — waitlist oscillation grace period');

  await test('single miss does NOT delete the seat (grace holds it)', async () => {
    const state = { flights: { [KEY]: waitlistSeat() } };
    await detectGoneFlights(searched, state, new Set()); // searched, seat not seen
    assert.ok(state.flights[KEY], 'seat should survive one miss');
    assert.strictEqual(state.flights[KEY].missed, 1);
  });

  await test('reappearing after a flicker clears the miss streak (no re-alert)', async () => {
    const state = { flights: { [KEY]: waitlistSeat({ missed: 1 }) } };
    await detectGoneFlights(searched, state, new Set([KEY])); // seen again this cycle
    assert.ok(state.flights[KEY], 'seat retained');
    assert.strictEqual(state.flights[KEY].missed, 0, 'miss streak reset to 0');
  });

  await test('GONE_GRACE_MISSES consecutive misses finally delete it', async () => {
    const state = { flights: { [KEY]: waitlistSeat({ missed: 1 }) } };
    await detectGoneFlights(searched, state, new Set()); // 2nd consecutive miss
    assert.ok(!state.flights[KEY], 'seat removed after 2 misses');
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

  console.log(`\n${'='.repeat(60)}`);
  console.log(`${passed + failed} tests, ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
})();
