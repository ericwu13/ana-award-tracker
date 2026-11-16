/**
 * Tests for src/bot-desktop.js — BOT_DESKTOP resolution and the relaunch decision.
 * Run: node test/bot-desktop.test.js
 *
 * The end-to-end case (actually re-running on another desktop) only runs on
 * Windows, where the launcher can be built.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolveDesktop, desktopToRelaunchOn, ensureLauncher, listDesktopWindows, ACTIVE_VAR, EXIT_NOT_STARTED } = require('../src/bot-desktop');
const { BOT_CHROME_PREFS } = require('../src/browser-window');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

console.log('resolveDesktop');
test('unset / blank means no bot desktop', () => {
  assert.strictEqual(resolveDesktop({}), null);
  assert.strictEqual(resolveDesktop({ BOT_DESKTOP: '' }), null);
  assert.strictEqual(resolveDesktop({ BOT_DESKTOP: '   ' }), null);
});
test('accepts a simple name, trimmed', () => {
  assert.strictEqual(resolveDesktop({ BOT_DESKTOP: 'AnaBot' }), 'AnaBot');
  assert.strictEqual(resolveDesktop({ BOT_DESKTOP: ' ana-bot_2 ' }), 'ana-bot_2');
});
test('rejects names that could escape the window station or the command line, and warns', () => {
  for (const bad of ['WinSta0\\Default', 'a b', 'x"y', 'a/b', 'é', 'x'.repeat(33)]) {
    const warnings = [];
    assert.strictEqual(resolveDesktop({ BOT_DESKTOP: bad }, m => warnings.push(m)), null, `value: ${JSON.stringify(bad)}`);
    assert.strictEqual(warnings.length, 1);
  }
});

console.log('desktopToRelaunchOn');
test('relaunches only on Windows, when configured, and not already there', () => {
  assert.strictEqual(desktopToRelaunchOn({ BOT_DESKTOP: 'AnaBot' }, 'win32'), 'AnaBot');
  assert.strictEqual(desktopToRelaunchOn({ BOT_DESKTOP: 'AnaBot' }, 'linux'), null);
  assert.strictEqual(desktopToRelaunchOn({}, 'win32'), null);
  assert.strictEqual(desktopToRelaunchOn({ BOT_DESKTOP: 'AnaBot', [ACTIVE_VAR]: 'AnaBot' }, 'win32'), null);
});
test('a process on a different desktop than the configured one still relaunches', () => {
  assert.strictEqual(desktopToRelaunchOn({ BOT_DESKTOP: 'AnaBot', [ACTIVE_VAR]: 'Other' }, 'win32'), 'AnaBot');
});

console.log('BOT_CHROME_PREFS');
test('turns off password saving and leak warnings, nested the way Chrome reads Preferences', () => {
  assert.strictEqual(BOT_CHROME_PREFS.credentials_enable_service, false);
  assert.strictEqual(BOT_CHROME_PREFS.profile.password_manager_enabled, false);
  assert.strictEqual(BOT_CHROME_PREFS.profile.password_manager_leak_detection, false);
});

if (process.platform === 'win32') {
  console.log('relaunch end-to-end (Windows)');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-desktop-test-'));
  const script = path.join(dir, 'entry.js');
  const botDesktop = path.join(__dirname, '..', 'src', 'bot-desktop.js');
  fs.writeFileSync(script, `
    const b = require(${JSON.stringify(botDesktop)});
    b.relaunchOnBotDesktop('[t]');
    console.log('ran active=' + process.env[b.ACTIVE_VAR] + ' arg=' + process.argv[2]);
    console.log(b.listDesktopWindows(process.env.BOT_DESKTOP).split('\\n').pop() || 'listed');
    process.exit(7);
  `);
  const run = (env) => spawnSync(process.execPath, [script, 'a b"c'], { encoding: 'utf8', env: { ...process.env, [ACTIVE_VAR]: '', ...env } });

  test('launcher builds', () => { assert.ok(fs.existsSync(ensureLauncher())); });
  test('re-runs on the desktop: output, argument quoting and exit code all pass through', () => {
    const res = run({ BOT_DESKTOP: 'AnaBotUnitTest' });
    assert.strictEqual(res.status, 7, res.stdout + res.stderr);
    assert.ok(res.stdout.includes('ran active=AnaBotUnitTest arg=a b"c'), res.stdout);
    assert.strictEqual(res.stdout.match(/ran active=/g).length, 1, 'body must run exactly once');
  });
  test('without BOT_DESKTOP the script just runs in place', () => {
    const res = run({ BOT_DESKTOP: '' });
    assert.strictEqual(res.status, 7);
    assert.ok(res.stdout.includes('ran active= arg=a b"c'), res.stdout);
  });
  test('the desktop disappears once nothing runs on it', () => {
    assert.ok(/does not exist/.test(listDesktopWindows('AnaBotUnitTest')));
  });
  test('launcher reports "not started" for a command that cannot run', () => {
    const res = spawnSync(ensureLauncher(), ['run', 'AnaBotUnitTest', 'C:\\no\\such\\program.exe'], { encoding: 'utf8' });
    assert.strictEqual(res.status, EXIT_NOT_STARTED);
  });
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed`);
