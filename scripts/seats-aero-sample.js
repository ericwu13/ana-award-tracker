/**
 * Capture one real seats.aero cached-search response so the field mapping in
 * src/sources/seats-aero.js can be checked against reality.
 *
 *   node scripts/seats-aero-sample.js            # first route tracked with seats.aero
 *   node scripts/seats-aero-sample.js TPE SFO 2026-12-01 2026-12-31
 *
 * Writes data/seats-aero-sample.json: the response envelope keys, the first 5
 * rows verbatim, and how rowToEntries() reads them. The API key is only sent
 * in the request header; it is never written to the file. Costs 1 API call.
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { apiKey, rowToEntries, rowsOf } = require('../src/sources/seats-aero');

async function main() {
  if (!apiKey()) { console.error('SEATS_AERO_API_KEY is not set in .env'); process.exit(1); }
  let [from, to, start, end] = process.argv.slice(2);
  if (!from) {
    const { loadRoutes, usesSource } = require('../src/routes');
    const route = loadRoutes().find(r => usesSource(r, 'seats.aero') && Object.keys(r.dates || {}).length);
    if (!route) { console.error('No tracked route; pass FROM TO START END'); process.exit(1); }
    const dates = Object.keys(route.dates).sort();
    [from, to, start, end] = [route.from, route.to, dates[0], dates[dates.length - 1]];
  }
  const qs = new URLSearchParams({ origin_airport: from, destination_airport: to, start_date: start, end_date: end || start, take: '50' });
  const res = await fetch(`https://seats.aero/partnerapi/search?${qs}`, {
    headers: { 'Partner-Authorization': apiKey(), accept: 'application/json' },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch (_) { body = null; }
  const rows = rowsOf(body);
  const out = {
    request: { from, to, start, end: end || start },
    status: res.status,
    envelopeKeys: body && !Array.isArray(body) ? Object.keys(body) : (Array.isArray(body) ? '(bare array)' : '(not JSON)'),
    hasMore: body && body.hasMore, moreURL: body && body.moreURL,
    rowCount: rows.length,
    sampleRows: rows.slice(0, 5),
    parsed: rows.slice(0, 5).map(rowToEntries),
    rawIfNotJson: body ? undefined : text.slice(0, 2000),
  };
  const file = path.join(__dirname, '..', 'data', 'seats-aero-sample.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`HTTP ${res.status}, ${rows.length} row(s). Wrote ${file}`);
}

main().catch(e => { console.error(e); process.exit(1); });
