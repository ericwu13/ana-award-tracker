/**
 * Tests for src/browser-window.js — BOT_MINIMIZE_WINDOWS policy and the CDP minimize call.
 * Run: node test/browser-window.test.js
 */
const assert = require('assert');
const { resolveMinimizeScope, shouldMinimize, minimizeWindow, applyWindowPolicy } = require('../src/browser-window');

let passed = 0;
const pending = [];
function test(name, fn) {
  pending.push(async () => {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
  });
}

/** Fake puppeteer Page whose CDP session records calls. */
function fakePage({ failOn = null, hang = false } = {}) {
  const calls = [];
  let detached = false;
  const client = {
    async send(method, params) {
      calls.push({ method, params });
      if (hang) return new Promise(() => {});
      if (failOn === method) throw new Error(`boom ${method}`);
      if (method === 'Browser.getWindowForTarget') return { windowId: 42 };
      return {};
    },
    async detach() { detached = true; },
  };
  return {
    page: { async createCDPSession() { if (failOn === 'createCDPSession') throw new Error('no cdp'); return client; } },
    calls,
    isDetached: () => detached,
  };
}

console.log('resolveMinimizeScope');
test('defaults to off', () => {
  assert.strictEqual(resolveMinimizeScope(undefined), 'off');
  assert.strictEqual(resolveMinimizeScope(''), 'off');
  assert.strictEqual(resolveMinimizeScope('garbage'), 'off');
});
test('accepts the three scopes case-insensitively', () => {
  assert.strictEqual(resolveMinimizeScope('OFF'), 'off');
  assert.strictEqual(resolveMinimizeScope(' KeepAlive '), 'keepalive');
  assert.strictEqual(resolveMinimizeScope('all'), 'all');
});
test('truthy shorthands mean all', () => {
  for (const v of ['1', 'true', 'yes', 'on']) assert.strictEqual(resolveMinimizeScope(v), 'all');
});

console.log('shouldMinimize');
test('off never minimizes', () => {
  assert.strictEqual(shouldMinimize('off', 'keepalive'), false);
  assert.strictEqual(shouldMinimize('off', 'search'), false);
});
test('keepalive minimizes only the keep-alive browser', () => {
  assert.strictEqual(shouldMinimize('keepalive', 'keepalive'), true);
  assert.strictEqual(shouldMinimize('keepalive', 'search'), false);
});
test('all minimizes both', () => {
  assert.strictEqual(shouldMinimize('all', 'keepalive'), true);
  assert.strictEqual(shouldMinimize('all', 'search'), true);
});

console.log('minimizeWindow');
test('sends getWindowForTarget then setWindowBounds(minimized) and detaches', async () => {
  const f = fakePage();
  const ok = await minimizeWindow(f.page);
  assert.strictEqual(ok, true);
  assert.deepStrictEqual(f.calls.map(c => c.method), ['Browser.getWindowForTarget', 'Browser.setWindowBounds']);
  assert.deepStrictEqual(f.calls[1].params, { windowId: 42, bounds: { windowState: 'minimized' } });
  assert.strictEqual(f.isDetached(), true);
});
test('never throws when CDP fails, still detaches, logs the reason', async () => {
  const logs = [];
  const f = fakePage({ failOn: 'Browser.setWindowBounds' });
  const ok = await minimizeWindow(f.page, { log: m => logs.push(m) });
  assert.strictEqual(ok, false);
  assert.strictEqual(f.isDetached(), true);
  assert.ok(logs.some(l => /Could not minimize/.test(l)), logs.join('|'));
});
test('never throws when createCDPSession fails', async () => {
  const f = fakePage({ failOn: 'createCDPSession' });
  assert.strictEqual(await minimizeWindow(f.page), false);
});
test('bounded by timeout when CDP hangs', async () => {
  const f = fakePage({ hang: true });
  const t0 = Date.now();
  const ok = await minimizeWindow(f.page, { timeoutMs: 50 });
  assert.strictEqual(ok, false);
  assert.ok(Date.now() - t0 < 1000, 'returned promptly');
  assert.strictEqual(f.isDetached(), true);
});

console.log('applyWindowPolicy');
test('does nothing when scope is off (no CDP session created)', async () => {
  const f = fakePage();
  const ok = await applyWindowPolicy(f.page, 'keepalive', { env: {} });
  assert.strictEqual(ok, false);
  assert.deepStrictEqual(f.calls, []);
});
test('keepalive scope minimizes keep-alive but not search', async () => {
  const a = fakePage();
  assert.strictEqual(await applyWindowPolicy(a.page, 'keepalive', { env: { BOT_MINIMIZE_WINDOWS: 'keepalive' } }), true);
  const b = fakePage();
  assert.strictEqual(await applyWindowPolicy(b.page, 'search', { env: { BOT_MINIMIZE_WINDOWS: 'keepalive' } }), false);
  assert.deepStrictEqual(b.calls, []);
});
test('all scope minimizes search sessions too', async () => {
  const f = fakePage();
  assert.strictEqual(await applyWindowPolicy(f.page, 'search', { env: { BOT_MINIMIZE_WINDOWS: 'all' } }), true);
});

(async () => {
  for (const t of pending) await t();
  console.log(`\n${passed} passed${process.exitCode ? ' (with failures)' : ''}`);
})();
