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
  extractPerFlightRecommendations,
  extractRecommendationsByRecId,
  extractFlightCardDataValues,
  extractPerFlightByCard,
  parseCallArgs,
  parseMilesArg,
  parseNumericArg,
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
section('parseCallArgs — bracket / brace nesting');
// ===========================================================================

test('commas inside [...] are not top-level splits', () => {
  const args = parseCallArgs("1,2,[3,4,5],6");
  assert.deepStrictEqual(args, ['1', '2', '[3,4,5]', '6']);
});

test('commas inside {...} are not top-level splits', () => {
  const args = parseCallArgs("1,{a:1,b:2},3");
  assert.deepStrictEqual(args, ['1', '{a:1,b:2}', '3']);
});

test('nested arrays and objects together (addRecommendation tail arg)', () => {
  const args = parseCallArgs("57000,[{segmentInfoList:[{serviceLevel:800},{serviceLevel:800}]}]");
  assert.strictEqual(args.length, 2);
  assert.strictEqual(args[0], '57000');
  assert.strictEqual(args[1], '[{segmentInfoList:[{serviceLevel:800},{serviceLevel:800}]}]');
});

// ===========================================================================
section('parseNumericArg — bare numbers and quoted numbers');
// ===========================================================================

test('bare integer (addRecommendation miles)', () => {
  assert.strictEqual(parseNumericArg('57000'), 57000);
});

test('bare decimal (addRecommendation tax in USD)', () => {
  assert.strictEqual(parseNumericArg('204.3'), 204.3);
});

test('quoted integer with comma (addFormatedRecommendation miles)', () => {
  assert.strictEqual(parseNumericArg("'57,000'"), 57000);
});

test('quoted decimal (addFormatedRecommendation tax string)', () => {
  assert.strictEqual(parseNumericArg("'204.30'"), 204.3);
});

test('null literal → null', () => {
  assert.strictEqual(parseNumericArg('null'), null);
});

test('empty string → null', () => {
  assert.strictEqual(parseNumericArg(''), null);
});

test('non-numeric → null', () => {
  assert.strictEqual(parseNumericArg("'NO_NO_RULE'"), null);
  assert.strictEqual(parseNumericArg('false'), null);
});

test('zero is valid (free tax for award searches sometimes shows 0.0)', () => {
  assert.strictEqual(parseNumericArg('0.0'), 0);
  assert.strictEqual(parseNumericArg("'0.00'"), 0);
});

// ===========================================================================
section('extractPerFlightRecommendations — addRecommendation → {miles, taxUsd}');
// ===========================================================================

const buildRec = (taxUsd, miles, recId = 0, flightId = 7) =>
  `addRecommendation(${flightId},${recId},null,'800',null,${taxUsd},null,${taxUsd},false,0,null,${miles},'NO_NO_RULE',null,'0',null,0.0,${taxUsd},0,'','',false,'',[{segmentInfoList : [{serviceLevel : 800},{serviceLevel : 800}]}]);`;

test('single flight: 57000 miles + $204.30 tax', () => {
  const html = `<script>${buildRec(204.3, 57000)}</script>`;
  assert.deepStrictEqual(extractPerFlightRecommendations(html), [
    { miles: 57000, taxUsd: 204.3 },
  ]);
});

test('five flights (matches real ANA HND→SFO data)', () => {
  const html = `<script>
    ${buildRec(204.3, 57000, 0, 7)}
    ${buildRec(204.3, 57000, 1, 7)}
    ${buildRec(213.6, 57000, 2, 8)}
    ${buildRec(213.6, 57000, 3, 8)}
    ${buildRec(235.1, 65000, 4, 9)}
  </script>`;
  assert.deepStrictEqual(extractPerFlightRecommendations(html), [
    { miles: 57000, taxUsd: 204.3 },
    { miles: 57000, taxUsd: 204.3 },
    { miles: 57000, taxUsd: 213.6 },
    { miles: 57000, taxUsd: 213.6 },
    { miles: 65000, taxUsd: 235.1 },
  ]);
});

test('partner UA flight: low miles (22500) + tax — args 5 and 11 work', () => {
  // Verifies the addRecommendation positional layout is consistent for
  // partner-award flights (UA) where the addFormatedRecommendation variant
  // can shift args due to promo flags.
  const html = buildRec(56.4, 22500, 0, 0);
  assert.deepStrictEqual(extractPerFlightRecommendations(html), [
    { miles: 22500, taxUsd: 56.4 },
  ]);
});

test('zero tax flight is preserved (taxUsd === 0, not null)', () => {
  const html = buildRec(0.0, 30000);
  assert.deepStrictEqual(extractPerFlightRecommendations(html), [
    { miles: 30000, taxUsd: 0 },
  ]);
});

test('tax with sub-cent precision is rounded to 2 decimals', () => {
  // Defensive: ANA sometimes emits 204.299999... due to float math
  const html = `addRecommendation(0,0,null,'800',null,204.299999,null,204.299999,false,0,null,57000,'NO_NO_RULE',null,'0',null,0.0,204.299999,0,'','',false,'',[]);`;
  const recs = extractPerFlightRecommendations(html);
  assert.strictEqual(recs[0].taxUsd, 204.3);
});

test('non-string input → empty array (defensive)', () => {
  assert.deepStrictEqual(extractPerFlightRecommendations(null), []);
  assert.deepStrictEqual(extractPerFlightRecommendations(undefined), []);
  assert.deepStrictEqual(extractPerFlightRecommendations(42), []);
});

test('no addRecommendation calls → empty array', () => {
  assert.deepStrictEqual(extractPerFlightRecommendations('<html>no flights</html>'), []);
});

test('REAL integration: parses data/flight-detail.html (miles + tax pairs)', () => {
  // The real saved ANA HTML from a previous search. Verified separately to
  // contain 5 addRecommendation calls matching the 5 flight cards.
  const fs = require('fs');
  const path = require('path');
  let html;
  try {
    html = fs.readFileSync(path.join(__dirname, '..', 'data', 'flight-detail.html'), 'utf8');
  } catch {
    console.log('    (fixture not present, skipping integration check)');
    return;
  }
  const recs = extractPerFlightRecommendations(html);
  assert.strictEqual(recs.length, 5, 'should find 5 addRecommendation calls');
  assert.deepStrictEqual(recs, [
    { miles: 57000, taxUsd: 204.3 },
    { miles: 57000, taxUsd: 204.3 },
    { miles: 57000, taxUsd: 213.6 },
    { miles: 57000, taxUsd: 213.6 },
    { miles: 65000, taxUsd: 235.1 },
  ]);
});

test('REGRESSION: trailing array arg does not throw off arg indexing', () => {
  // The 24th arg of addRecommendation is `[{segmentInfoList:[...]}]`. If
  // parseCallArgs ever loses bracket/brace awareness, commas inside the
  // array would split into extra args and could shift earlier indices.
  // We pin the test by checking the values at arg 5 (tax) and 11 (miles).
  const html = `addRecommendation(0,0,null,'800',null,42.5,null,42.5,false,0,null,12345,'NO_NO_RULE',null,'0',null,0.0,42.5,0,'','',false,'',[{a:[1,2,3],b:{c:4,d:5}}]);`;
  assert.deepStrictEqual(extractPerFlightRecommendations(html), [
    { miles: 12345, taxUsd: 42.5 },
  ]);
});

// ===========================================================================
section('extractRecommendationsByRecId — Map<recId, {miles, taxUsd}>');
// ===========================================================================

test('keys by recId (arg 1), not source-code position', () => {
  // Calls emitted in (flightId, recId) order. recId is the second arg.
  const html = `
    addRecommendation(2,4,null,'1200',null,174.43,null,174.43,false,0,null,30000,'NO_NO_RULE',null,'0',null,0.0,174.43,0,'','',false,'',[]);
    addRecommendation(0,0,null,'1400',null,199.33,null,199.33,false,0,null,22500,'NO_NO_RULE',null,'0',null,0.0,199.33,0,'','',false,'',[]);
  `;
  const map = extractRecommendationsByRecId(html);
  assert.strictEqual(map.size, 2);
  // Source order put recId=4 first but the map keys it correctly:
  assert.deepStrictEqual(map.get(4), { miles: 30000, taxUsd: 174.43 });
  assert.deepStrictEqual(map.get(0), { miles: 22500, taxUsd: 199.33 });
});

test('empty / non-string input → empty Map', () => {
  assert.strictEqual(extractRecommendationsByRecId('').size, 0);
  assert.strictEqual(extractRecommendationsByRecId(null).size, 0);
  assert.strictEqual(extractRecommendationsByRecId(undefined).size, 0);
});

test('call with missing/garbage recId is skipped', () => {
  const html = `
    addRecommendation(0,null,null,'1400',null,199.33,null,199.33,false,0,null,22500,'NO_NO_RULE',null,'0',null,0.0,199.33,0,'','',false,'',[]);
    addRecommendation(0,'abc',null,'1400',null,199.33,null,199.33,false,0,null,22500,'NO_NO_RULE',null,'0',null,0.0,199.33,0,'','',false,'',[]);
  `;
  assert.strictEqual(extractRecommendationsByRecId(html).size, 0);
});

// ===========================================================================
section('extractFlightCardDataValues — DOM-order radio data-values');
// ===========================================================================

test('reads data-value from radio inside td.selectItineraryCheck', () => {
  const html = `
    <tbody>
      <tr><td class="selectItineraryCheck"><i role="button" data-value="4"></i></td></tr>
      <tr><td class="selectItineraryCheck"><i role="button" data-value="5"></i></td></tr>
      <tr><td class="selectItineraryCheck"><i role="button" data-value="0"></i></td></tr>
    </tbody>
  `;
  assert.deepStrictEqual(extractFlightCardDataValues(html), [4, 5, 0]);
});

test('tolerates extra classes on the td (real ANA HTML has multiple)', () => {
  const html = `<td class="something selectItineraryCheck other" onclick="..."><i role="button" data-value="9"></i></td>`;
  assert.deepStrictEqual(extractFlightCardDataValues(html), [9]);
});

test('no cards on page → empty array', () => {
  assert.deepStrictEqual(extractFlightCardDataValues('<html>nothing here</html>'), []);
});

test('empty / non-string input → empty array (defensive)', () => {
  assert.deepStrictEqual(extractFlightCardDataValues(''), []);
  assert.deepStrictEqual(extractFlightCardDataValues(null), []);
  assert.deepStrictEqual(extractFlightCardDataValues(undefined), []);
});

// ===========================================================================
section('extractPerFlightByCard — composes the two above (DOM card order)');
// ===========================================================================

test('reorders recommendations to match flight-card DOM order', () => {
  // Calls in recId order (0, 1, 2). Cards displayed in (2, 0, 1) order.
  const html = `
    addRecommendation(0,0,null,'1400',null,100,null,100,false,0,null,10000,'X',null,'0',null,0,100,0,'','',false,'',[]);
    addRecommendation(0,1,null,'1400',null,200,null,200,false,0,null,20000,'X',null,'0',null,0,200,0,'','',false,'',[]);
    addRecommendation(0,2,null,'1400',null,300,null,300,false,0,null,30000,'X',null,'0',null,0,300,0,'','',false,'',[]);
    <td class="selectItineraryCheck"><i role="button" data-value="2"></i></td>
    <td class="selectItineraryCheck"><i role="button" data-value="0"></i></td>
    <td class="selectItineraryCheck"><i role="button" data-value="1"></i></td>
  `;
  assert.deepStrictEqual(extractPerFlightByCard(html), [
    { miles: 30000, taxUsd: 300 }, // card[0] dv=2 → recId 2
    { miles: 10000, taxUsd: 100 }, // card[1] dv=0 → recId 0
    { miles: 20000, taxUsd: 200 }, // card[2] dv=1 → recId 1
  ]);
});

test('card whose data-value has no matching recommendation → {null, null}', () => {
  const html = `
    addRecommendation(0,0,null,'1400',null,100,null,100,false,0,null,10000,'X',null,'0',null,0,100,0,'','',false,'',[]);
    <td class="selectItineraryCheck"><i role="button" data-value="0"></i></td>
    <td class="selectItineraryCheck"><i role="button" data-value="7"></i></td>
  `;
  assert.deepStrictEqual(extractPerFlightByCard(html), [
    { miles: 10000, taxUsd: 100 },
    { miles: null, taxUsd: null },
  ]);
});

// ===========================================================================
section('REAL fixtures — captured live from ANA on 2026-05-19');
// ===========================================================================

test('REAL: TPE→SFO 2026-06-25 economy — by-card mapping matches click-through', () => {
  // Live-captured HTML for the user-reported bug case. The click-through
  // diagnostic (selecting UA872 → next-step page) showed actual cost as
  // "30,000 Miles + USD174.43". This confirms the by-card mapping returns
  // exactly that — proving the parser bug was the sequential mapping, not
  // missing tax data.
  //
  // Display order on the page (confirmed first, then waitlist) doesn't
  // match the addRecommendation source order (by recId), so the old
  // sequential parser silently pulled the wrong row for every flight.
  //
  // Card order (data-value → recId → expected):
  //   [0] UA872 confirmed       dv=4 → 30,000 + $174.43  ← was wrongly 22,500
  //   [1] UA852 confirmed       dv=5 → 30,000 + $174.43  ← was wrongly 22,500
  //   [2] NH854+NH108 waitlist  dv=0 → 22,500 + $199.33
  //   [3] NH852+NH108 waitlist  dv=1 → 22,500 + $199.33
  //   [4] NH854+NH008 waitlist  dv=2 → 22,500 + $209.93  ← was wrongly 30,000
  //   [5] NH852+NH008 waitlist  dv=3 → 22,500 + $209.93  ← was wrongly 30,000
  //
  // Fixture is gitignored (in data/). Re-capture via:
  //   node diag-tpe-sfo-live.js   (from parent project root)
  const fs = require('fs');
  const path = require('path');
  let html;
  try {
    html = fs.readFileSync(path.join(__dirname, '..', 'data', 'flight-detail-tpe-sfo-2026-06-25.html'), 'utf8');
  } catch {
    console.log('    (live-capture fixture not present, skipping)');
    return;
  }
  assert.deepStrictEqual(extractFlightCardDataValues(html), [4, 5, 0, 1, 2, 3],
    'card data-values should be [4,5,0,1,2,3] (confirmed-first display sort)');
  assert.deepStrictEqual(extractPerFlightByCard(html), [
    { miles: 30000, taxUsd: 174.43 }, // UA872
    { miles: 30000, taxUsd: 174.43 }, // UA852
    { miles: 22500, taxUsd: 199.33 }, // NH854+NH108
    { miles: 22500, taxUsd: 199.33 }, // NH852+NH108
    { miles: 22500, taxUsd: 209.93 }, // NH854+NH008
    { miles: 22500, taxUsd: 209.93 }, // NH852+NH008
  ]);
});

test('REAL: SFO→TPE 2026-08-09 economy — by-card mapping (BR/UA/NH split)', () => {
  // Companion capture from the same diagnostic run. addRecommendation source
  // order: recIds [4,5,0,1,2,3]. Card data-values: [0,1,2,3,4,5]. The buggy
  // sequential mapping wrongly assigned BR027 (slot 0) recId 4's value
  // (39,500) when its actual price is recId 0's value (30,000). Pins the
  // corrected output.
  const fs = require('fs');
  const path = require('path');
  let html;
  try {
    html = fs.readFileSync(path.join(__dirname, '..', 'data', 'flight-detail-sfo-tpe-2026-08-09.html'), 'utf8');
  } catch {
    console.log('    (live-capture fixture not present, skipping)');
    return;
  }
  assert.deepStrictEqual(extractFlightCardDataValues(html), [0, 1, 2, 3, 4, 5]);
  assert.deepStrictEqual(extractPerFlightByCard(html), [
    { miles: 30000, taxUsd: 239 },    // BR027 (partner)
    { miles: 30000, taxUsd: 239 },    // BR007 (partner)
    { miles: 30000, taxUsd: 279 },    // UA871 (partner)
    { miles: 30000, taxUsd: 279 },    // UA853 (partner)
    { miles: 39500, taxUsd: 313.2 },  // NH007+NH851 (ANA-only — higher chart)
    { miles: 39500, taxUsd: 313.2 },  // NH007+NH853 (ANA-only)
  ]);
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
