/**
 * Tests for src/seatsaero.js — seats.aero Partner API → ANA-shaped results.
 * No network: fetch is stubbed.
 *
 * Run:  node test/seatsaero.test.js
 */
process.env.ANA_INDEX_NOAUTORUN = '1';
process.env.ANA_USERNAME = 'test';
process.env.ANA_PASSWORD = 'test';
process.env.DISCORD_BOT_TOKEN = '';
process.env.GONE_GRACE_MISSES = '3';

const assert = require('assert');
const sa = require('../src/seatsaero');
const { processOneResult, detectGoneFlights, flightKey } = require('../src/index.js');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}`); console.log(`    ${e.stack}`); failed++; }
}

const ROUTE = { from: 'SFO', to: 'HND', dates: {
  '2027-01-10': ['business'],
  '2027-01-12': ['business', 'premium-economy'],
} };

// Shaped after the OpenAPI example in developers.seats.aero.
const ROW_BIZ = {
  ID: 'av1', Date: '2027-01-10', Source: 'aeroplan',
  Route: { OriginAirport: 'SFO', DestinationAirport: 'HND', Source: 'aeroplan' },
  JAvailable: true, JMileageCost: '87500', JRemainingSeats: 2, JAirlines: 'NH', JDirect: true,
  WAvailable: false, YAvailable: true, YMileageCost: '40000',
  AvailabilityTrips: [
    { ID: 't1', Cabin: 'business', FlightNumbers: 'NH7', MileageCost: 87500, TotalTaxes: 5610,
      TaxesCurrency: 'USD', Stops: 0, RemainingSeats: 2, TotalDuration: 690,
      DepartsAt: '2027-01-10T11:00:00Z', ArrivesAt: '2027-01-11T15:30:00Z', Source: 'aeroplan',
      AvailabilitySegments: [{ Order: 0, OriginAirport: 'SFO', DestinationAirport: 'HND', FlightNumber: 'NH7' }] },
    { ID: 't2', Cabin: 'economy', FlightNumbers: 'UA837', MileageCost: 40000, Source: 'aeroplan' },
  ],
};
const ROW_SUMMARY_ONLY = {
  ID: 'av2', Date: '2027-01-12', Source: 'united',
  Route: { OriginAirport: 'SFO', DestinationAirport: 'HND' },
  WAvailable: true, WMileageCost: '60000', WAirlines: 'UA, NH', WDirect: false, WRemainingSeats: 4,
  JAvailable: false, AvailabilityTrips: null,
};

function stubFetch(pages, calls = []) {
  let i = 0;
  return async (url, init) => {
    calls.push({ url, init });
    const body = pages[Math.min(i++, pages.length - 1)];
    if (body.__status) return { ok: false, status: body.__status, text: async () => 'nope', json: async () => ({}) };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
}

(async () => {
  console.log('\nseats.aero mapping');

  await test('trip → ANA-shaped result (miles, taxes, times, duration)', () => {
    const r = sa.tripToResult(ROW_BIZ.AvailabilityTrips[0], ROW_BIZ, 'business');
    assert.strictEqual(r.source, 'aeroplan');
    assert.strictEqual(r.flightNumber, 'NH7');
    assert.strictEqual(r.miles, 87500);
    assert.strictEqual(r.taxUsd, 56.10);
    assert.strictEqual(r.depTime, '11:00');
    assert.strictEqual(r.duration, '11h30min');
    assert.strictEqual(r.layover, false);
    assert.strictEqual(r.available, true);
    assert.strictEqual(r.waitlist, false);
    assert.ok(r.cabinDesc.toLowerCase().includes('business'));
  });

  await test('non-USD taxes are not shown as $', () => {
    assert.strictEqual(sa.taxesToUsd(5610, 'CAD'), null);
    assert.strictEqual(sa.taxesToUsd(5610, ''), 56.10);
  });

  await test('rowsToEntries: one entry per tracked (date, cabin); untracked cabins dropped', () => {
    const entries = sa.rowsToEntries(ROUTE, [ROW_BIZ, ROW_SUMMARY_ONLY]);
    assert.strictEqual(entries.length, 3);
    const e10 = entries.find(e => e.date === '2027-01-10');
    assert.strictEqual(e10.cabin, 'seats.aero:Business');
    assert.strictEqual(e10.results.length, 1, 'economy trip not tracked → dropped');
    const e12pe = entries.find(e => e.date === '2027-01-12' && e.cabin === 'seats.aero:Premium Economy');
    assert.strictEqual(e12pe.results[0].flightNumber, 'UA,NH-any', 'summary fallback when no trips');
    assert.strictEqual(e12pe.results[0].miles, 60000);
    const e12biz = entries.find(e => e.date === '2027-01-12' && e.cabin === 'seats.aero:Business');
    assert.deepStrictEqual(e12biz.results, [{ noResults: true }], 'searched-but-empty marks combo as searched');
  });

  await test('fetchRoute: auth header, query params, pagination with dedup', async () => {
    const calls = [];
    const fetchImpl = stubFetch([
      { data: [ROW_BIZ], hasMore: true, cursor: 123 },
      { data: [ROW_BIZ, ROW_SUMMARY_ONLY], hasMore: false, cursor: 123 },
    ], calls);
    const rows = await sa.fetchRoute(
      { from: 'SFO', to: 'HND', startDate: '2027-01-10', endDate: '2027-01-12', cabins: ['business', 'premium'] },
      { apiKey: 'KEY', fetchImpl, sources: 'aeroplan,united' });
    assert.strictEqual(rows.length, 2, 'duplicate ID across pages dropped');
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[0].init.headers['Partner-Authorization'], 'KEY');
    const u0 = new URL(calls[0].url);
    assert.strictEqual(u0.origin + u0.pathname, 'https://seats.aero/partnerapi/search');
    assert.strictEqual(u0.searchParams.get('cabins'), 'business,premium');
    assert.strictEqual(u0.searchParams.get('include_trips'), 'true');
    assert.strictEqual(u0.searchParams.get('sources'), 'aeroplan,united');
    const u1 = new URL(calls[1].url);
    assert.strictEqual(u1.searchParams.get('cursor'), '123');
    assert.strictEqual(u1.searchParams.get('skip'), '1');
  });

  await test('searchSeatsAero: disabled without key', async () => {
    const r = await sa.searchSeatsAero([ROUTE], null, { apiKey: '' });
    assert.strictEqual(r.enabled, false);
  });

  await test('searchSeatsAero: HTTP error → no entries for that route (GONE skips it)', async () => {
    const r = await sa.searchSeatsAero([ROUTE], null, { apiKey: 'K', fetchImpl: stubFetch([{ __status: 401 }]), log: () => {} });
    assert.strictEqual(r.entries.length, 0);
    assert.strictEqual(r.errors[0].status, 401);
  });

  console.log('\nseats.aero → existing state / GONE pipeline');

  await test('flightKey keeps seats.aero seats separate from ANA seats', () => {
    const ana = flightKey('SFO→HND', '2027-01-10', { flightNumber: 'NH7' });
    const sae = flightKey('SFO→HND', '2027-01-10', { flightNumber: 'NH7', source: 'aeroplan' });
    assert.notStrictEqual(ana, sae);
  });

  await test('processOneResult stores seat; GONE removes it after 3 empty cycles', async () => {
    const state = { flights: {} };
    const [entry] = sa.rowsToEntries(ROUTE, [ROW_BIZ]).filter(e => e.date === '2027-01-10');
    const { seenKeys } = await processOneResult(entry, state);
    assert.strictEqual(seenKeys.length, 1);
    const key = seenKeys[0];
    assert.strictEqual(state.flights[key].searchedCabin, 'seats.aero:Business');
    assert.strictEqual(state.flights[key].source, 'aeroplan');

    const empty = sa.rowsToEntries(ROUTE, []); // cycle with no availability
    // ANA searched the same route/date but GONE must not count that against the seats.aero seat
    const anaOnly = [{ route: 'SFO→HND', date: '2027-01-10', cabin: 'Business', results: [{ noResults: true }] }];
    await detectGoneFlights(anaOnly, state, new Set());
    assert.strictEqual(state.flights[key].missed, undefined, 'ANA search does not count as seats.aero miss');

    for (let i = 0; i < 2; i++) await detectGoneFlights(empty, state, new Set());
    assert.ok(state.flights[key], 'held during grace');
    await detectGoneFlights(empty, state, new Set());
    assert.ok(!state.flights[key], 'removed after 3 misses');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
