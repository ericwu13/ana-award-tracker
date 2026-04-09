/**
 * Unit tests for pure helpers in src/parser.js.
 *
 * These tests exercise the text/HTML-matching logic without running a
 * browser or touching the filesystem. Safe to run while the bot is live.
 *
 * Run:  node test/parser.test.js
 * Exits with code 1 on any failure.
 */
const assert = require('assert');
const {
  extractPerFlightMiles,
  parseCallArgs,
  parseMilesArg,
} = require('../src/parser');

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
section('parseCallArgs — comma-respecting arg splitter');
// ===========================================================================

test('simple nulls + numbers', () => {
  const args = parseCallArgs("'a',null,'b'");
  assert.deepStrictEqual(args, ["'a'", 'null', "'b'"]);
});

test('quoted string with embedded comma is one arg', () => {
  // '57,000' has an internal comma — must not split it
  const args = parseCallArgs("null,'57,000',null");
  assert.deepStrictEqual(args, ['null', "'57,000'", 'null']);
});

test('escaped characters inside quoted strings', () => {
  // ANA's HTML has \" for inner double quotes inside single-quoted JS strings
  const args = parseCallArgs("'<em class=\\\"price\\\">0<\\/em>',null,'57,000'");
  assert.strictEqual(args.length, 3);
  assert.strictEqual(args[1], 'null');
  assert.strictEqual(args[2], "'57,000'");
});

test('real addFormatedRecommendation call args', () => {
  const callInner = "'USD<br />204.30',null,'204.30','<em class=\\\"price\\\">0<\\/em><span class=\\\"currencyCode\\\">Miles<\\/span>',null,'57,000',null,null,'0.00','From USD<br />204.30',null,'','','','','','From USD<br />0.00',''";
  const args = parseCallArgs(callInner);
  assert.strictEqual(args[0], "'USD<br />204.30'");
  assert.strictEqual(args[1], 'null');
  assert.strictEqual(args[2], "'204.30'");
  assert.strictEqual(args[4], 'null');
  assert.strictEqual(args[5], "'57,000'"); // the miles argument
  assert.strictEqual(args[6], 'null');
});

test('empty string → empty array', () => {
  assert.deepStrictEqual(parseCallArgs(''), []);
});

// ===========================================================================
section('parseMilesArg — individual arg → miles int');
// ===========================================================================

test("'57,000' → 57000", () => {
  assert.strictEqual(parseMilesArg("'57,000'"), 57000);
});

test("'65,000' → 65000", () => {
  assert.strictEqual(parseMilesArg("'65,000'"), 65000);
});

test("'150,000' → 150000 (six figures)", () => {
  assert.strictEqual(parseMilesArg("'150,000'"), 150000);
});

test("'30000' → 30000 (no comma)", () => {
  assert.strictEqual(parseMilesArg("'30000'"), 30000);
});

test("null → null", () => {
  assert.strictEqual(parseMilesArg('null'), null);
});

test("empty string → null", () => {
  assert.strictEqual(parseMilesArg(''), null);
});

test("non-quoted bare number → null (defensive — ANA always quotes)", () => {
  assert.strictEqual(parseMilesArg('57000'), null);
});

test("quoted non-numeric → null", () => {
  assert.strictEqual(parseMilesArg("'N/A'"), null);
});

test("quoted decimal (looks like tax, not miles) → null", () => {
  assert.strictEqual(parseMilesArg("'204.30'"), null);
});

test("undefined arg → null (defensive)", () => {
  assert.strictEqual(parseMilesArg(undefined), null);
});

// ===========================================================================
section('extractPerFlightMiles — full HTML → miles array');
// ===========================================================================

// Reusable fixture: one ANA addFormatedRecommendation call with variable miles.
// Mirrors the real structure from data/flight-detail.html, using the same
// escaped-double-quote pattern that ANA outputs in the inline script.
const buildCall = (tax, miles) =>
  `addFormatedRecommendation('USD<br />${tax}',null,'${tax}','<em class=\\"price\\">0<\\/em><span class=\\"currencyCode\\">Miles<\\/span>',null,'${miles}',null,null,'0.00','From USD<br />${tax}',null,'','','','','','From USD<br />0.00','');`;

test('single flight', () => {
  const html = `<html><body><script>${buildCall('204.30', '57,000')}</script></body></html>`;
  assert.deepStrictEqual(extractPerFlightMiles(html), [57000]);
});

test('five flights with varying miles (matches real ANA HND→SFO data)', () => {
  const html = `<script>
    ${buildCall('204.30', '57,000')}
    ${buildCall('204.30', '57,000')}
    ${buildCall('213.60', '57,000')}
    ${buildCall('213.60', '57,000')}
    ${buildCall('235.10', '65,000')}
  </script>`;
  assert.deepStrictEqual(extractPerFlightMiles(html), [57000, 57000, 57000, 57000, 65000]);
});

test('mixed cabin: Business 85k + Premium Economy 55k + Economy 30k', () => {
  const html = `
    ${buildCall('412.60', '85,000')}
    ${buildCall('305.10', '55,000')}
    ${buildCall('215.00', '30,000')}
  `;
  assert.deepStrictEqual(extractPerFlightMiles(html), [85000, 55000, 30000]);
});

test('no addFormatedRecommendation calls → empty array', () => {
  const html = '<html><body>No flights found</body></html>';
  assert.deepStrictEqual(extractPerFlightMiles(html), []);
});

test('empty string → empty array', () => {
  assert.deepStrictEqual(extractPerFlightMiles(''), []);
});

test('null / undefined / non-string → empty array (defensive)', () => {
  assert.deepStrictEqual(extractPerFlightMiles(null), []);
  assert.deepStrictEqual(extractPerFlightMiles(undefined), []);
  assert.deepStrictEqual(extractPerFlightMiles({ not: 'a string' }), []);
});

test('call with too few args (<6) → null in that slot', () => {
  const html = `addFormatedRecommendation('a',null,'b','c',null);`;
  assert.deepStrictEqual(extractPerFlightMiles(html), [null]);
});

test('call with garbage 6th arg → null in that slot', () => {
  const html = `addFormatedRecommendation('a',null,'b','c',null,'N/A',null);`;
  assert.deepStrictEqual(extractPerFlightMiles(html), [null]);
});

test('mixed: some calls parse, some do not', () => {
  const html = `
    ${buildCall('100.00', '30,000')}
    addFormatedRecommendation('a',null,'b','c',null,'N/A',null);
    ${buildCall('200.00', '60,000')}
  `;
  assert.deepStrictEqual(extractPerFlightMiles(html), [30000, null, 60000]);
});

test('calls spread across HTML with other content between', () => {
  const html = `
    <html><body>
    <div class="flight-list">
      <div>Some flight UI</div>
      <script>
        var x = 1;
        ${buildCall('100.00', '30,000')}
      </script>
      <div>More UI</div>
      <script>
        ${buildCall('200.00', '60,000')}
      </script>
    </body></html>
  `;
  assert.deepStrictEqual(extractPerFlightMiles(html), [30000, 60000]);
});

test('REAL integration: parses data/flight-detail.html correctly', () => {
  // The real saved ANA HTML from a previous search. Verified separately that
  // it contains 5 addFormatedRecommendation calls: 4x 57,000 and 1x 65,000.
  const fs = require('fs');
  const path = require('path');
  let html;
  try {
    html = fs.readFileSync(path.join(__dirname, '..', 'data', 'flight-detail.html'), 'utf8');
  } catch {
    // Fixture not present — skip (not a failure; some environments won't have it)
    console.log('    (fixture not present, skipping integration check)');
    return;
  }
  const miles = extractPerFlightMiles(html);
  assert.strictEqual(miles.length, 5, 'should find 5 addFormatedRecommendation calls');
  assert.deepStrictEqual(
    miles,
    [57000, 57000, 57000, 57000, 65000],
    'should extract per-flight miles matching the 5 flights on the page'
  );
});

test('REGRESSION: comma inside "57,000" must not split the arg', () => {
  // If parseCallArgs ever breaks its quote-awareness, args[5] would become
  // '57' and parseMilesArg would return 57 instead of 57000. Catch that.
  const html = buildCall('100.00', '57,000');
  const miles = extractPerFlightMiles(html);
  assert.strictEqual(miles.length, 1);
  assert.strictEqual(miles[0], 57000, 'miles must be 57000, not 57');
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
