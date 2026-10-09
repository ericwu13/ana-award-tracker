/**
 * Tests for src/browser-window.js — BOT_WINDOW_POSITION resolution.
 * Run: node test/browser-window.test.js
 */
const assert = require('assert');
const { parseWindowPosition, resolveWindowPosition, windowPositionArg, MAX_ABS } = require('../src/browser-window');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

console.log('parseWindowPosition');
test('parses "x,y" with negatives and whitespace', () => {
  assert.deepStrictEqual(parseWindowPosition('-20000,0'), { x: -20000, y: 0 });
  assert.deepStrictEqual(parseWindowPosition(' 10 , 20 '), { x: 10, y: 20 });
  assert.deepStrictEqual(parseWindowPosition('0,0'), { x: 0, y: 0 });
});
test('rejects unset and malformed values', () => {
  for (const v of [undefined, null, '', 'abc', '10', '10,', ',10', '10,20,30', '1.5,2', '10;20', '1234567,0']) {
    assert.strictEqual(parseWindowPosition(v), null, `value: ${JSON.stringify(v)}`);
  }
});
test(`rejects |value| > ${MAX_ABS} (Windows minimized sentinel -32000, int16 after DPI scaling)`, () => {
  assert.strictEqual(parseWindowPosition('-32000,-32000'), null);
  assert.strictEqual(parseWindowPosition('0,20001'), null);
  assert.deepStrictEqual(parseWindowPosition('-20000,20000'), { x: -20000, y: 20000 });
});

console.log('resolveWindowPosition — legacy (env unset) reproduces master exactly');
test('keep-alive at -2560,679', () => {
  assert.deepStrictEqual(resolveWindowPosition('keepalive', { env: {} }), { x: -2560, y: 679 });
});
test('search session 1 at -1600,679 and session 2 at -1280,679 (= -1920 + id*320)', () => {
  assert.deepStrictEqual(resolveWindowPosition('search', { id: 1, env: {} }), { x: -1600, y: 679 });
  assert.deepStrictEqual(resolveWindowPosition('search', { id: 2, env: {} }), { x: -1280, y: 679 });
  assert.deepStrictEqual(resolveWindowPosition('search', { id: 3, env: {} }), { x: -960, y: 679 });
});
test('malformed env falls back to legacy and warns via log', () => {
  const logs = [];
  assert.deepStrictEqual(resolveWindowPosition('keepalive', { env: { BOT_WINDOW_POSITION: 'nope' }, log: m => logs.push(m) }), { x: -2560, y: 679 });
  assert.strictEqual(logs.length, 1);
  assert.ok(/BOT_WINDOW_POSITION/.test(logs[0]) && /legacy/.test(logs[0]), logs[0]);
});
test('unset or blank env does not warn', () => {
  const logs = [];
  resolveWindowPosition('keepalive', { env: {}, log: m => logs.push(m) });
  resolveWindowPosition('keepalive', { env: { BOT_WINDOW_POSITION: '  ' }, log: m => logs.push(m) });
  assert.deepStrictEqual(logs, []);
});

console.log('resolveWindowPosition — BOT_WINDOW_POSITION set');
test('keep-alive uses the configured position verbatim', () => {
  assert.deepStrictEqual(resolveWindowPosition('keepalive', { env: { BOT_WINDOW_POSITION: '-20000,0' } }), { x: -20000, y: 0 });
});
test('search sessions stagger +320px per id from the configured position', () => {
  const env = { BOT_WINDOW_POSITION: '-20000,0' };
  assert.deepStrictEqual(resolveWindowPosition('search', { id: 1, env }), { x: -20000, y: 0 });
  assert.deepStrictEqual(resolveWindowPosition('search', { id: 2, env }), { x: -19680, y: 0 });
});

console.log('windowPositionArg');
test('formats a Chrome switch', () => {
  assert.strictEqual(windowPositionArg('keepalive', { env: {} }), '--window-position=-2560,679');
  assert.strictEqual(windowPositionArg('search', { id: 2, env: { BOT_WINDOW_POSITION: '-20000,0' } }), '--window-position=-19680,0');
});

console.log(`\n${passed} passed${process.exitCode ? ' (with failures)' : ''}`);
