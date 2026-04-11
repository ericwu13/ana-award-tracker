/**
 * Unit tests for the pure helpers in src/routes.js.
 *
 * These tests exercise the data-model logic in isolation — they never touch
 * the filesystem, so they are safe to run while the bot is live and
 * idempotent between runs.
 *
 * Run:  node test/routes.test.js
 * Exits with code 1 on any failure (for CI use).
 */
const assert = require('assert');
const {
  parseDateInput,
  expandDateRange,
  expandCabinKeyword,
  sortCabinKeys,
  migrateRoute,
  addDatesWithCabins,
  removeDatesFromRoute,
  groupDatesByCabinSignature,
  CABIN_ORDER,
} = require('../src/routes');

// --- minimal test runner ---------------------------------------------------
let passed = 0;
let failed = 0;
const failures = [];

function section(name) {
  console.log(`\n${name}`);
}

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
    if (e.actual !== undefined || e.expected !== undefined) {
      console.log(`    actual:   ${JSON.stringify(e.actual)}`);
      console.log(`    expected: ${JSON.stringify(e.expected)}`);
    }
    failed++;
    failures.push({ name, error: e });
  }
}

// ===========================================================================
// ===========================================================================
section('parseDateInput + expandDateRange');
// ===========================================================================

test('single date: "2026-07-10"', () => {
  assert.deepStrictEqual(parseDateInput('2026-07-10'), ['2026-07-10']);
});

test('month: "2026-07" → weekly expansion', () => {
  const dates = parseDateInput('2026-07');
  assert.strictEqual(dates[0], '2026-07-01');
  assert.ok(dates.length >= 4 && dates.length <= 5);
});

test('range with tilde: "2026-07-10~2026-07-13" → 4 daily dates', () => {
  assert.deepStrictEqual(
    parseDateInput('2026-07-10~2026-07-13'),
    ['2026-07-10', '2026-07-11', '2026-07-12', '2026-07-13']
  );
});

test('range with "to": "2026-07-10 to 2026-07-13" → 4 daily dates', () => {
  assert.deepStrictEqual(
    parseDateInput('2026-07-10 to 2026-07-13'),
    ['2026-07-10', '2026-07-11', '2026-07-12', '2026-07-13']
  );
});

test('range: same start and end → single date', () => {
  assert.deepStrictEqual(parseDateInput('2026-07-10~2026-07-10'), ['2026-07-10']);
});

test('range: end before start → swapped silently', () => {
  assert.deepStrictEqual(
    parseDateInput('2026-07-13~2026-07-10'),
    ['2026-07-10', '2026-07-11', '2026-07-12', '2026-07-13']
  );
});

test('range: cross-month boundary', () => {
  assert.deepStrictEqual(
    parseDateInput('2026-07-30~2026-08-02'),
    ['2026-07-30', '2026-07-31', '2026-08-01', '2026-08-02']
  );
});

test('range: "to" case-insensitive', () => {
  assert.deepStrictEqual(
    parseDateInput('2026-07-10 TO 2026-07-12'),
    ['2026-07-10', '2026-07-11', '2026-07-12']
  );
});

test('invalid input → null', () => {
  assert.strictEqual(parseDateInput('not-a-date'), null);
  assert.strictEqual(parseDateInput(''), null);
});

test('expandDateRange directly: 3 days', () => {
  assert.deepStrictEqual(
    expandDateRange('2026-12-29', '2026-12-31'),
    ['2026-12-29', '2026-12-30', '2026-12-31']
  );
});

// ===========================================================================
section('expandCabinKeyword');
// ===========================================================================

test("'both' → [PE, Biz]", () => {
  assert.deepStrictEqual(expandCabinKeyword('both'), ['premium-economy', 'business']);
});

test("'all' → [PE, Eco, Biz]", () => {
  assert.deepStrictEqual(expandCabinKeyword('all'), ['premium-economy', 'economy', 'business']);
});

test("'economy' → [Economy]", () => {
  assert.deepStrictEqual(expandCabinKeyword('economy'), ['economy']);
});

test("'business' → [Business]", () => {
  assert.deepStrictEqual(expandCabinKeyword('business'), ['business']);
});

test("'premium-economy' → [PE]", () => {
  assert.deepStrictEqual(expandCabinKeyword('premium-economy'), ['premium-economy']);
});

test('undefined → default (both)', () => {
  assert.deepStrictEqual(expandCabinKeyword(undefined), ['premium-economy', 'business']);
});

test('unknown keyword → default (both)', () => {
  assert.deepStrictEqual(expandCabinKeyword('random-garbage'), ['premium-economy', 'business']);
});

// ===========================================================================
section('sortCabinKeys (canonical order)');
// ===========================================================================

test('keys in arbitrary order → PE, Eco, Biz', () => {
  assert.deepStrictEqual(
    sortCabinKeys(['business', 'economy', 'premium-economy']),
    ['premium-economy', 'economy', 'business']
  );
});

test('deduplicates while sorting', () => {
  assert.deepStrictEqual(
    sortCabinKeys(['business', 'business', 'premium-economy']),
    ['premium-economy', 'business']
  );
});

test('empty input → empty', () => {
  assert.deepStrictEqual(sortCabinKeys([]), []);
});

test('CABIN_ORDER constant matches expected canonical order', () => {
  assert.deepStrictEqual(CABIN_ORDER, ['premium-economy', 'economy', 'business']);
});

// ===========================================================================
section('migrateRoute (legacy → current schema)');
// ===========================================================================

test('legacy cabin="both" → each date gets [PE, Biz]', () => {
  const old = { from: 'HND', to: 'SFO', dates: ['2026-05-01', '2026-05-08'], cabin: 'both' };
  const migrated = migrateRoute(old);
  assert.deepStrictEqual(migrated.dates, {
    '2026-05-01': ['premium-economy', 'business'],
    '2026-05-08': ['premium-economy', 'business'],
  });
  assert.strictEqual(migrated.cabin, undefined, 'cabin field should be removed');
  assert.strictEqual(migrated.from, 'HND');
  assert.strictEqual(migrated.to, 'SFO');
});

test('legacy cabin="all" → each date gets [PE, Eco, Biz]', () => {
  const old = { from: 'HND', to: 'SFO', dates: ['2026-07-05'], cabin: 'all' };
  const migrated = migrateRoute(old);
  assert.deepStrictEqual(migrated.dates['2026-07-05'], ['premium-economy', 'economy', 'business']);
});

test('legacy cabin="business" → each date gets [Biz] only', () => {
  const old = { from: 'SFO', to: 'TPE', dates: ['2026-11-01', '2026-11-08'], cabin: 'business' };
  const migrated = migrateRoute(old);
  assert.deepStrictEqual(migrated.dates['2026-11-01'], ['business']);
  assert.deepStrictEqual(migrated.dates['2026-11-08'], ['business']);
});

test('legacy cabin="premium-economy" → each date gets [PE] only', () => {
  const old = { from: 'HND', to: 'NRT', dates: ['2026-06-01'], cabin: 'premium-economy' };
  const migrated = migrateRoute(old);
  assert.deepStrictEqual(migrated.dates['2026-06-01'], ['premium-economy']);
});

test('legacy without cabin field → default [PE, Biz]', () => {
  const old = { from: 'TPE', to: 'SFO', dates: ['2026-10-01'] };
  const migrated = migrateRoute(old);
  assert.deepStrictEqual(migrated.dates['2026-10-01'], ['premium-economy', 'business']);
});

test('new format passes through unchanged (idempotent)', () => {
  const current = { from: 'HND', to: 'SFO', dates: { '2026-05-01': ['premium-economy', 'business'] } };
  const migrated = migrateRoute(current);
  assert.deepStrictEqual(migrated, current);
});

test('legacy empty dates array → empty object', () => {
  const old = { from: 'HND', to: 'SFO', dates: [], cabin: 'both' };
  const migrated = migrateRoute(old);
  assert.deepStrictEqual(migrated.dates, {});
  assert.strictEqual(migrated.cabin, undefined);
});

test('migration does not mutate the input object', () => {
  const old = { from: 'HND', to: 'SFO', dates: ['2026-05-01'], cabin: 'both' };
  const snapshot = JSON.parse(JSON.stringify(old));
  migrateRoute(old);
  assert.deepStrictEqual(old, snapshot, 'input object should not be mutated');
});

// ===========================================================================
section('addDatesWithCabins');
// ===========================================================================

test('adding a new date to an empty route', () => {
  const route = { from: 'HND', to: 'SFO', dates: {} };
  const result = addDatesWithCabins(route, ['2026-05-01'], ['premium-economy', 'business']);
  assert.deepStrictEqual(route.dates, { '2026-05-01': ['premium-economy', 'business'] });
  assert.deepStrictEqual(result.newlyAddedDates, ['2026-05-01']);
  assert.deepStrictEqual(result.updatedDates, []);
});

test('adding identical date+cabins is a no-op', () => {
  const route = { from: 'HND', to: 'SFO', dates: { '2026-05-01': ['premium-economy', 'business'] } };
  const result = addDatesWithCabins(route, ['2026-05-01'], ['premium-economy', 'business']);
  assert.deepStrictEqual(route.dates['2026-05-01'], ['premium-economy', 'business']);
  assert.deepStrictEqual(result.newlyAddedDates, []);
  assert.deepStrictEqual(result.updatedDates, []);
});

test('adding a new cabin to an existing date is additive (marked updated)', () => {
  const route = { from: 'HND', to: 'SFO', dates: { '2026-05-01': ['premium-economy', 'business'] } };
  const result = addDatesWithCabins(route, ['2026-05-01'], ['economy']);
  assert.deepStrictEqual(route.dates['2026-05-01'], ['premium-economy', 'economy', 'business']);
  assert.deepStrictEqual(result.newlyAddedDates, []);
  assert.deepStrictEqual(result.updatedDates, ['2026-05-01']);
});

test('partial overlap: some cabins already present, some new', () => {
  // Existing: [PE]; adding: [PE, Eco] → union [PE, Eco], marked updated
  const route = { from: 'HND', to: 'SFO', dates: { '2026-05-01': ['premium-economy'] } };
  const result = addDatesWithCabins(route, ['2026-05-01'], ['premium-economy', 'economy']);
  assert.deepStrictEqual(route.dates['2026-05-01'], ['premium-economy', 'economy']);
  assert.deepStrictEqual(result.updatedDates, ['2026-05-01']);
});

test("adding 'all' to a date with [PE, Biz] yields [PE, Eco, Biz]", () => {
  const route = { from: 'HND', to: 'SFO', dates: { '2026-05-01': ['premium-economy', 'business'] } };
  const result = addDatesWithCabins(route, ['2026-05-01'], ['premium-economy', 'economy', 'business']);
  assert.deepStrictEqual(route.dates['2026-05-01'], ['premium-economy', 'economy', 'business']);
  assert.deepStrictEqual(result.updatedDates, ['2026-05-01']);
});

test('mixed batch: new date + existing date gaining a cabin + existing date no-op', () => {
  const route = {
    from: 'HND', to: 'SFO',
    dates: {
      '2026-05-01': ['premium-economy', 'business'],
      '2026-05-08': ['premium-economy', 'economy', 'business'],
    },
  };
  const result = addDatesWithCabins(
    route,
    ['2026-05-01', '2026-05-08', '2026-05-15'],
    ['economy']
  );
  // 05-01 gains Economy → updated
  assert.deepStrictEqual(route.dates['2026-05-01'], ['premium-economy', 'economy', 'business']);
  // 05-08 already has Economy → no-op
  assert.deepStrictEqual(route.dates['2026-05-08'], ['premium-economy', 'economy', 'business']);
  // 05-15 is new → added with just Economy
  assert.deepStrictEqual(route.dates['2026-05-15'], ['economy']);
  assert.deepStrictEqual(result.newlyAddedDates, ['2026-05-15']);
  assert.deepStrictEqual(result.updatedDates, ['2026-05-01']);
});

test('cabin keys stored in canonical order regardless of input order', () => {
  const route = { from: 'HND', to: 'SFO', dates: {} };
  addDatesWithCabins(route, ['2026-05-01'], ['business', 'economy', 'premium-economy']);
  assert.deepStrictEqual(route.dates['2026-05-01'], ['premium-economy', 'economy', 'business']);
});

test('route.dates was undefined → initialized to {}', () => {
  const route = { from: 'HND', to: 'SFO' };
  addDatesWithCabins(route, ['2026-05-01'], ['premium-economy']);
  assert.deepStrictEqual(route.dates, { '2026-05-01': ['premium-economy'] });
});

test('route.dates was an array (legacy) → reset to {} before adding', () => {
  const route = { from: 'HND', to: 'SFO', dates: ['legacy-date'] };
  addDatesWithCabins(route, ['2026-05-01'], ['premium-economy']);
  assert.deepStrictEqual(route.dates, { '2026-05-01': ['premium-economy'] });
});

test('REGRESSION: two /track calls with different cabins do NOT destroy existing cabins', () => {
  // This is the exact bug the whole refactor is fixing. Reproduce it, then
  // assert the correct (additive) behavior.
  const route = { from: 'HND', to: 'SFO', dates: {} };

  // First /track: HND SFO 2026-05-01 cabin=both (PE+Biz)
  addDatesWithCabins(route, ['2026-05-01'], expandCabinKeyword('both'));

  // Second /track: HND SFO 2026-05-01 cabin=economy
  // (Old addRoute would overwrite route.cabin from 'both' to 'economy',
  //  silently dropping PE+Biz from this date.)
  addDatesWithCabins(route, ['2026-05-01'], expandCabinKeyword('economy'));

  // Expected: date has all three cabins (additive union)
  assert.deepStrictEqual(
    route.dates['2026-05-01'],
    ['premium-economy', 'economy', 'business'],
    'PE+Biz must survive a subsequent add of Economy'
  );
});

// ===========================================================================
section('removeDatesFromRoute');
// ===========================================================================

test('remove entire date (no cabin filter) → date deleted', () => {
  const route = {
    from: 'HND', to: 'SFO',
    dates: {
      '2026-05-01': ['premium-economy', 'business'],
      '2026-05-08': ['premium-economy', 'business'],
    },
  };
  const result = removeDatesFromRoute(route, ['2026-05-01']);
  assert.deepStrictEqual(Object.keys(route.dates), ['2026-05-08']);
  assert.deepStrictEqual(result.removedDates, ['2026-05-01']);
  assert.deepStrictEqual(result.updatedDates, []);
});

test('remove specific cabin → cabin removed, date kept, sorted', () => {
  const route = { from: 'HND', to: 'SFO', dates: { '2026-05-01': ['premium-economy', 'economy', 'business'] } };
  const result = removeDatesFromRoute(route, ['2026-05-01'], ['economy']);
  assert.deepStrictEqual(route.dates['2026-05-01'], ['premium-economy', 'business']);
  assert.deepStrictEqual(result.updatedDates, ['2026-05-01']);
  assert.deepStrictEqual(result.removedDates, []);
});

test('remove last cabin from a date → date deleted entirely', () => {
  const route = { from: 'HND', to: 'SFO', dates: { '2026-05-01': ['economy'] } };
  const result = removeDatesFromRoute(route, ['2026-05-01'], ['economy']);
  assert.strictEqual(route.dates['2026-05-01'], undefined);
  assert.deepStrictEqual(result.removedDates, ['2026-05-01']);
  assert.deepStrictEqual(result.updatedDates, []);
});

test('remove cabin that does not exist on date → no-op', () => {
  const route = { from: 'HND', to: 'SFO', dates: { '2026-05-01': ['premium-economy', 'business'] } };
  const result = removeDatesFromRoute(route, ['2026-05-01'], ['economy']);
  assert.deepStrictEqual(route.dates['2026-05-01'], ['premium-economy', 'business']);
  assert.deepStrictEqual(result.removedDates, []);
  assert.deepStrictEqual(result.updatedDates, []);
});

test('remove nonexistent date → no-op', () => {
  const route = { from: 'HND', to: 'SFO', dates: { '2026-05-01': ['premium-economy', 'business'] } };
  const result = removeDatesFromRoute(route, ['2026-12-01']);
  assert.deepStrictEqual(Object.keys(route.dates), ['2026-05-01']);
  assert.deepStrictEqual(result.removedDates, []);
  assert.deepStrictEqual(result.updatedDates, []);
});

test('remove multiple dates mixing present and missing', () => {
  const route = {
    from: 'HND', to: 'SFO',
    dates: {
      '2026-05-01': ['premium-economy', 'business'],
      '2026-05-08': ['premium-economy', 'business'],
    },
  };
  const result = removeDatesFromRoute(route, ['2026-05-01', '2026-12-01']);
  assert.deepStrictEqual(Object.keys(route.dates), ['2026-05-08']);
  assert.deepStrictEqual(result.removedDates, ['2026-05-01']);
});

test('remove multiple cabins at once (via expandCabinKeyword("both"))', () => {
  // Simulates: /untrack HND SFO 2026-05-01 cabin:both → removes both PE and Biz
  // (only valid internally; Discord choices don't expose "both" for untrack,
  //  but the underlying function should behave correctly if given the keys)
  const route = { from: 'HND', to: 'SFO', dates: { '2026-05-01': ['premium-economy', 'economy', 'business'] } };
  const result = removeDatesFromRoute(route, ['2026-05-01'], ['premium-economy', 'business']);
  assert.deepStrictEqual(route.dates['2026-05-01'], ['economy']);
  assert.deepStrictEqual(result.updatedDates, ['2026-05-01']);
});

// ===========================================================================
section('groupDatesByCabinSignature (display grouping)');
// ===========================================================================

test('single date, single cabin set → one group', () => {
  const route = { from: 'HND', to: 'SFO', dates: { '2026-05-01': ['premium-economy', 'business'] } };
  const groups = groupDatesByCabinSignature(route);
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].signature, 'premium-economy+business');
  assert.deepStrictEqual(groups[0].dates, ['2026-05-01']);
});

test('multiple dates sharing the same cabin set → single group', () => {
  const route = {
    from: 'HND', to: 'SFO',
    dates: {
      '2026-05-01': ['premium-economy', 'business'],
      '2026-05-08': ['premium-economy', 'business'],
      '2026-05-15': ['premium-economy', 'business'],
    },
  };
  const groups = groupDatesByCabinSignature(route);
  assert.strictEqual(groups.length, 1);
  assert.deepStrictEqual(groups[0].dates, ['2026-05-01', '2026-05-08', '2026-05-15']);
});

test('mixed cabin sets per date → one group per signature, dates sorted', () => {
  const route = {
    from: 'HND', to: 'SFO',
    dates: {
      '2026-05-01': ['premium-economy', 'business'],
      '2026-05-08': ['premium-economy', 'business'],
      '2026-07-05': ['premium-economy', 'economy', 'business'],
      '2026-09-07': ['premium-economy', 'business'],
    },
  };
  const groups = groupDatesByCabinSignature(route);
  assert.strictEqual(groups.length, 2);
  const peb = groups.find(g => g.signature === 'premium-economy+business');
  const all = groups.find(g => g.signature === 'premium-economy+economy+business');
  assert.ok(peb, 'PE+Biz group missing');
  assert.ok(all, 'PE+Eco+Biz group missing');
  assert.deepStrictEqual(peb.dates, ['2026-05-01', '2026-05-08', '2026-09-07']);
  assert.deepStrictEqual(all.dates, ['2026-07-05']);
});

test('signature uses canonical cabin order regardless of stored order', () => {
  // Even if somehow a date got stored with cabins in non-canonical order
  // (shouldn't happen through the public API, but defensive), the signature
  // should still use the canonical order.
  const route = { from: 'HND', to: 'SFO', dates: { '2026-05-01': ['business', 'premium-economy'] } };
  const groups = groupDatesByCabinSignature(route);
  assert.strictEqual(groups[0].signature, 'premium-economy+business');
});

test('empty route → empty array', () => {
  const route = { from: 'HND', to: 'SFO', dates: {} };
  assert.deepStrictEqual(groupDatesByCabinSignature(route), []);
});

test('legacy (array) shape → empty array (safe, no crash)', () => {
  const route = { from: 'HND', to: 'SFO', dates: ['2026-05-01'] };
  assert.deepStrictEqual(groupDatesByCabinSignature(route), []);
});

// ===========================================================================
section('end-to-end scenarios (pure-function level)');
// ===========================================================================

test('scenario: user /track default then /track all on one date → only that date changes', () => {
  // Intent: "track HND→SFO May 1-15 with default PE+Biz; add Economy only on Jul 5"
  const route = { from: 'HND', to: 'SFO', dates: {} };

  // First /track (default = 'both')
  addDatesWithCabins(
    route,
    ['2026-05-01', '2026-05-08', '2026-05-15', '2026-07-05'],
    expandCabinKeyword('both')
  );

  // Second /track targets 2026-07-05 with 'all' (PE+Eco+Biz)
  const r2 = addDatesWithCabins(route, ['2026-07-05'], expandCabinKeyword('all'));

  // May dates must stay PE+Biz (not destroyed)
  assert.deepStrictEqual(route.dates['2026-05-01'], ['premium-economy', 'business']);
  assert.deepStrictEqual(route.dates['2026-05-08'], ['premium-economy', 'business']);
  assert.deepStrictEqual(route.dates['2026-05-15'], ['premium-economy', 'business']);
  // 7/5 gains Economy
  assert.deepStrictEqual(route.dates['2026-07-05'], ['premium-economy', 'economy', 'business']);
  // Second call reports only 7/5 updated
  assert.deepStrictEqual(r2.newlyAddedDates, []);
  assert.deepStrictEqual(r2.updatedDates, ['2026-07-05']);
});

test('scenario: /untrack HND SFO 2026-07-05 cabin=economy → 7/5 reverts, rest intact', () => {
  const route = {
    from: 'HND', to: 'SFO',
    dates: {
      '2026-05-01': ['premium-economy', 'business'],
      '2026-05-08': ['premium-economy', 'business'],
      '2026-07-05': ['premium-economy', 'economy', 'business'],
    },
  };
  const result = removeDatesFromRoute(route, ['2026-07-05'], expandCabinKeyword('economy'));
  assert.deepStrictEqual(route.dates['2026-07-05'], ['premium-economy', 'business']);
  assert.deepStrictEqual(route.dates['2026-05-01'], ['premium-economy', 'business']);
  assert.deepStrictEqual(route.dates['2026-05-08'], ['premium-economy', 'business']);
  assert.deepStrictEqual(result.updatedDates, ['2026-07-05']);
  assert.deepStrictEqual(result.removedDates, []);
});

test("scenario: full lifecycle — build with migration, mutate, display", () => {
  // Start from a legacy route that's been wrongly overwritten with cabin='all'
  // (exactly the shape your current routes.json is in for HND→SFO right now).
  const legacy = {
    from: 'HND', to: 'SFO',
    dates: ['2026-05-01', '2026-05-08', '2026-05-15', '2026-07-05', '2026-09-07'],
    cabin: 'all',
  };

  // Migrate: every date becomes [PE, Eco, Biz] (because that's what cabin='all' means)
  const route = migrateRoute(legacy);
  for (const d of legacy.dates) {
    assert.deepStrictEqual(route.dates[d], ['premium-economy', 'economy', 'business']);
  }

  // User fixes intent: keep 7/5 as all-three, but remove Economy from the May dates
  removeDatesFromRoute(route, ['2026-05-01', '2026-05-08', '2026-05-15'], ['economy']);

  // Verify state after cleanup
  assert.deepStrictEqual(route.dates['2026-05-01'], ['premium-economy', 'business']);
  assert.deepStrictEqual(route.dates['2026-05-08'], ['premium-economy', 'business']);
  assert.deepStrictEqual(route.dates['2026-05-15'], ['premium-economy', 'business']);
  assert.deepStrictEqual(route.dates['2026-07-05'], ['premium-economy', 'economy', 'business']);
  assert.deepStrictEqual(route.dates['2026-09-07'], ['premium-economy', 'economy', 'business']);

  // Display grouping
  const groups = groupDatesByCabinSignature(route);
  assert.strictEqual(groups.length, 2);
  const peb = groups.find(g => g.signature === 'premium-economy+business');
  const all = groups.find(g => g.signature === 'premium-economy+economy+business');
  assert.deepStrictEqual(peb.dates, ['2026-05-01', '2026-05-08', '2026-05-15']);
  assert.deepStrictEqual(all.dates.sort(), ['2026-07-05', '2026-09-07']);
});

// ===========================================================================
// Summary
// ===========================================================================
console.log(`\n${'='.repeat(60)}`);
console.log(`${passed + failed} tests, ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f.name}`);
  process.exit(1);
}
