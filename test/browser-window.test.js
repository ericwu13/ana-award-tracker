/**
 * Tests for src/browser-window.js — BOT_WINDOW_POSITION resolution.
 * Run: node test/browser-window.test.js
 */
const assert = require('assert');
const { parseWindowPosition, resolveWindowPosition, windowPositionArg } = require('../src/browser-window');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

console.log('parseWindowPosition');
test('parses "x,y" with negatives and whitespace', () => {
  assert.deepStrictEqual(parseWindowPosition('-32000,-32000'), { x: -32000, y: -32000 });
  assert.deepStrictEqual(parseWindowPosition(' 10 , 20 '), { x: 10, y: 20 });
  assert.deepStrictEqual(parseWindowPosition('0,0'), { x: 0, y: 0 });
});
test('rejects unset and malformed values', () => {
  for (const v of [undefined, null, '', 'abc', '10', '10,', ',10', '10,20,30', '1.5,2', '10;20', '1234567,0']) {
    assert.strictEqual(parseWindowPosition(v), null, `value: ${JSON.stringify(v)}`);
  }
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
test('malformed env falls back to legacy', () => {
  assert.deepStrictEqual(resolveWindowPosition('keepalive', { env: { BOT_WINDOW_POSITION: 'nope' } }), { x: -2560, y: 679 });
});

console.log('resolveWindowPosition — BOT_WINDOW_POSITION set');
test('keep-alive uses the configured position verbatim', () => {
  assert.deepStrictEqual(resolveWindowPosition('keepalive', { env: { BOT_WINDOW_POSITION: '-32000,-32000' } }), { x: -32000, y: -32000 });
});
test('search sessions stagger +320px per id from the configured position', () => {
  const env = { BOT_WINDOW_POSITION: '-32000,-32000' };
  assert.deepStrictEqual(resolveWindowPosition('search', { id: 1, env }), { x: -32000, y: -32000 });
  assert.deepStrictEqual(resolveWindowPosition('search', { id: 2, env }), { x: -31680, y: -32000 });
});

console.log('windowPositionArg');
test('formats a Chrome switch', () => {
  assert.strictEqual(windowPositionArg('keepalive', { env: {} }), '--window-position=-2560,679');
  assert.strictEqual(windowPositionArg('search', { id: 2, env: { BOT_WINDOW_POSITION: '-32000,-32000' } }), '--window-position=-31680,-32000');
});

console.log(`\n${passed} passed${process.exitCode ? ' (with failures)' : ''}`);
