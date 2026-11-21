/**
 * Load-reduction helpers: BOT_BLOCK_RESOURCES patterns, keep-alive skip gate,
 * old log / capture pruning. Run: node test/load-reduction.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseBlockList, fetchPatterns, applyResourceBlocking, CATEGORY_TYPES } = require('../src/browser-load');
const { keepAliveSkipReason } = require('../src/keepalive-gate');
const { pruneOldFiles, retentionDays } = require('../src/disk-cleanup');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('\nBOT_BLOCK_RESOURCES parsing');
test('unset / empty / off → nothing', () => {
  for (const v of [undefined, '', '  ', 'off', 'none', 'images,off']) {
    assert.deepStrictEqual(parseBlockList(v).categories, [], `value ${JSON.stringify(v)}`);
  }
});
test('categories are trimmed, lowercased, deduped', () => {
  assert.deepStrictEqual(parseBlockList(' Images, fonts ,images,MEDIA').categories, ['images', 'fonts', 'media']);
});
test('unknown categories are reported, not applied', () => {
  const r = parseBlockList('images,scripts,css');
  assert.deepStrictEqual(r.categories, ['images']);
  assert.deepStrictEqual(r.unknown, ['scripts', 'css']);
});

console.log('\nFetch.enable patterns (blocked by resource type, never by URL)');
test('each category maps to exactly one CDP resource type at request stage', () => {
  assert.deepStrictEqual(fetchPatterns(['images', 'fonts', 'media']), [
    { resourceType: 'Image', requestStage: 'Request' },
    { resourceType: 'Font', requestStage: 'Request' },
    { resourceType: 'Media', requestStage: 'Request' },
  ]);
});
test('only selected categories are intercepted; none → no patterns', () => {
  assert.deepStrictEqual(fetchPatterns(['fonts']), [{ resourceType: 'Font', requestStage: 'Request' }]);
  assert.deepStrictEqual(fetchPatterns([]), []);
});
test('scripts, XHR, documents and stylesheets can never be selected', () => {
  const types = Object.values(CATEGORY_TYPES);
  for (const t of ['Script', 'XHR', 'Fetch', 'Document', 'Stylesheet', 'Ping', 'Other']) {
    assert.ok(!types.includes(t), t);
  }
});
// async: failure sets exitCode instead of being counted synchronously
(async () => {
  let opened = false;
  const page = { createCDPSession: async () => { opened = true; } };
  const applied = await applyResourceBlocking(page, { env: {} });
  assert.deepStrictEqual(applied, []);
  assert.strictEqual(opened, false);
  console.log('  ✓ applyResourceBlocking is a no-op when unset (no CDP session opened)');
})().catch(e => { console.log(`  ✗ applyResourceBlocking no-op\n    ${e.message}`); process.exitCode = 1; });

console.log('\nKeep-alive skip gate');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ana-load-'));
const lockFile = path.join(tmp, 'run.lock');
const stateFile = path.join(tmp, 'state.json');
const NOW = Date.parse('2026-11-21T12:00:00Z');
const gate = (over = {}) => keepAliveSkipReason({ env: {}, now: NOW, lockFile, stateFile, isAlive: () => false, lastKeepAliveSuccess: NOW - 10 * 60000, ...over });
const writeLock = (pid, minAgo = 1) => { fs.writeFileSync(lockFile, String(pid)); const t = new Date(NOW - minAgo * 60000); fs.utimesSync(lockFile, t, t); };
const writeState = (minAgo, checked) => fs.writeFileSync(stateFile, JSON.stringify({
  lastCoverage: { timestamp: new Date(NOW - minAgo * 60000).toISOString(), checked },
}));
const reset = () => { for (const f of [lockFile, stateFile]) try { fs.unlinkSync(f); } catch (_) {} };

test('no lock, no state → run', () => { reset(); assert.strictEqual(gate(), null); });
test('live run.lock → skip', () => {
  reset(); writeLock(4242);
  assert.match(gate({ isAlive: pid => pid === 4242 }), /in progress/);
});
test('stale run.lock (dead pid) → run', () => {
  reset(); writeLock(4242);
  assert.strictEqual(gate(), null);
});
test('successful cycle 10 min ago → skip', () => {
  reset(); writeState(10, 12);
  assert.match(gate(), /10 min ago/);
});
test('successful cycle 45 min ago → run (outside default 30)', () => {
  reset(); writeState(45, 12);
  assert.strictEqual(gate(), null);
});
test('recent cycle that checked nothing (blocked / expired) → run', () => {
  reset(); writeState(5, 0);
  assert.strictEqual(gate(), null);
});
test('KEEPALIVE_SKIP_AFTER_RUN_MIN=0 disables skipping, even with a live lock', () => {
  reset(); writeState(1, 5); writeLock(4242);
  assert.strictEqual(gate({ env: { KEEPALIVE_SKIP_AFTER_RUN_MIN: '0' }, isAlive: () => true }), null);
});
test('custom window and garbage value', () => {
  reset(); writeState(45, 3);
  assert.match(gate({ env: { KEEPALIVE_SKIP_AFTER_RUN_MIN: '60' } }), /45 min ago/);
  assert.strictEqual(gate({ env: { KEEPALIVE_SKIP_AFTER_RUN_MIN: 'abc' } }), null); // falls back to 30
});
test('live-looking run.lock older than 2 h (PID reused) → ignored', () => {
  reset(); writeLock(4242, 121);
  assert.strictEqual(gate({ isAlive: () => true }), null);
});
test('last keep-alive success >60 min ago → run even after a fresh cycle / live lock', () => {
  reset(); writeState(5, 12); writeLock(4242);
  assert.strictEqual(gate({ isAlive: () => true, lastKeepAliveSuccess: NOW - 61 * 60000 }), null);
});
test('no keep-alive success yet (bot just started) → run', () => {
  reset(); writeState(5, 12);
  assert.strictEqual(gate({ lastKeepAliveSuccess: null }), null);
});
test('KEEPALIVE_MAX_SKIP_MIN override', () => {
  reset(); writeState(5, 12);
  const last = NOW - 61 * 60000;
  assert.match(gate({ env: { KEEPALIVE_MAX_SKIP_MIN: '90' }, lastKeepAliveSuccess: last }), /5 min ago/);
  assert.strictEqual(gate({ env: { KEEPALIVE_MAX_SKIP_MIN: 'abc' }, lastKeepAliveSuccess: last }), null);
});
test('corrupt state.json → run', () => {
  reset(); fs.writeFileSync(stateFile, '{not json');
  assert.strictEqual(gate(), null);
});

console.log('\nOld log / capture pruning');
const dataDir = path.join(tmp, 'data');
fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
const mk = (rel, daysOld) => {
  const f = path.join(dataDir, rel);
  fs.writeFileSync(f, 'x'.repeat(100));
  const t = (NOW - daysOld * 86400000) / 1000;
  fs.utimesSync(f, t, t);
};
mk('logs/run-2026-09-01.log', 81);
mk('logs/run-2026-11-20.log', 1);
mk('logs/notes.log', 200);            // not our pattern
mk('form-error-2026-08-01-1.html', 60);
mk('form-error-2026-08-01-1.png', 60);
mk('form-error-2026-11-20-1.png', 1);
mk('state.json', 400);                // never touched
mk('cookies.json', 400);
mk('login-failed.png', 400);

test('default retention is 30 days; 0 and garbage handled', () => {
  assert.strictEqual(retentionDays({}), 30);
  assert.strictEqual(retentionDays({ LOG_RETENTION_DAYS: '0' }), 0);
  assert.strictEqual(retentionDays({ LOG_RETENTION_DAYS: '-3' }), 30);
});
test('LOG_RETENTION_DAYS=0 deletes nothing', () => {
  assert.strictEqual(pruneOldFiles({ dataDir, env: { LOG_RETENTION_DAYS: '0' }, now: NOW }).removed.length, 0);
});
test('removes only old run logs + form-error captures', () => {
  const r = pruneOldFiles({ dataDir, env: {}, now: NOW });
  assert.deepStrictEqual(r.removed.sort(), [
    'form-error-2026-08-01-1.html', 'form-error-2026-08-01-1.png', path.join('logs', 'run-2026-09-01.log'),
  ].sort());
  assert.strictEqual(r.bytes, 300);
  for (const keep of ['logs/run-2026-11-20.log', 'logs/notes.log', 'form-error-2026-11-20-1.png', 'state.json', 'cookies.json', 'login-failed.png']) {
    assert.ok(fs.existsSync(path.join(dataDir, keep)), `kept ${keep}`);
  }
});
test('missing data dir is fine', () => {
  assert.deepStrictEqual(pruneOldFiles({ dataDir: path.join(tmp, 'nope'), env: {}, now: NOW }).removed, []);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
