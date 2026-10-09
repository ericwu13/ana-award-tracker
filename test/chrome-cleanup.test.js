/**
 * Tests for src/chrome-cleanup.js — classification of bot Chrome processes.
 * Run: node test/chrome-cleanup.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { classifyChrome, profileDirOf, sweepStaleProfileDirs } = require('../src/chrome-cleanup');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

const TMP = 'C:\\Users\\eric8\\AppData\\Local\\Temp';
const CHROME = '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"';

function botMain(pid, ppid, n, tmp = TMP) {
  return { pid, ppid, name: 'chrome.exe', cmd: `${CHROME} --remote-debugging-port=51234 --user-data-dir=${tmp}\\lighthouse.${n} --disable-features=Translate,AutomationControlled --start-minimized --no-sandbox about:blank` };
}
function botChild(pid, ppid, n, type, tmp = TMP) {
  return { pid, ppid, name: 'chrome.exe', cmd: `${CHROME} --type=${type} --user-data-dir=${tmp}\\lighthouse.${n} --mojo-platform-channel-handle=1234` };
}
function userMain(pid, ppid) {
  return { pid, ppid, name: 'chrome.exe', cmd: `${CHROME} --flag-switches-begin --flag-switches-end` };
}
function userChild(pid, ppid, type) {
  return { pid, ppid, name: 'chrome.exe', cmd: `${CHROME} --type=${type} "--user-data-dir=C:\\Users\\eric8\\AppData\\Local\\Google\\Chrome\\User Data" --mojo=1` };
}
const node = (pid, ppid = 4) => ({ pid, ppid, name: 'node.exe', cmd: 'node run-once.js' });
const OPTS = { tmpDir: TMP };

console.log('profileDirOf');
test('extracts unquoted lighthouse dir', () => {
  assert.strictEqual(profileDirOf(botMain(1, 2, 12345678).cmd), `${TMP}\\lighthouse.12345678`);
});
test('extracts libuv/Chrome whole-argument quoting when TEMP contains a space', () => {
  const cmd = `${CHROME} --remote-debugging-port=5 "--user-data-dir=C:\\Users\\John Doe\\AppData\\Local\\Temp\\lighthouse.999" --start-minimized`;
  assert.strictEqual(profileDirOf(cmd), 'C:\\Users\\John Doe\\AppData\\Local\\Temp\\lighthouse.999');
  const child = `${CHROME} --type=renderer "--user-data-dir=C:\\Users\\John Doe\\AppData\\Local\\Temp\\lighthouse.999" --mojo=1`;
  assert.strictEqual(profileDirOf(child), 'C:\\Users\\John Doe\\AppData\\Local\\Temp\\lighthouse.999');
});
test('ignores the user\'s real profile (quoted, with space, no lighthouse)', () => {
  assert.strictEqual(profileDirOf(userChild(1, 2, 'renderer').cmd), null);
  assert.strictEqual(profileDirOf(userMain(1, 2).cmd), null);
});
test('null/empty command line', () => {
  assert.strictEqual(profileDirOf(null), null);
  assert.strictEqual(profileDirOf(''), null);
});
test('crashpad handler references the profile via --database', () => {
  const cmd = `${CHROME} --type=crashpad-handler /prefetch:4 --database=${TMP}\\lighthouse.555\\Crashpad --url=https://clients2.google.com/cr/report`;
  assert.strictEqual(profileDirOf(cmd), `${TMP}\\lighthouse.555`);
});
test('does NOT match lighthouse.<n> outside --user-data-dir/--database (reviewer false-positive cases)', () => {
  assert.strictEqual(profileDirOf(`${CHROME} --single-argument C:\\reports\\lighthouse.2024\\index.html`), null);
  assert.strictEqual(profileDirOf(`${CHROME} --load-extension=C:\\dev\\lighthouse.1\\ext`), null);
  assert.strictEqual(profileDirOf(`${CHROME} --app=https://x.com/?p=C:/foo/lighthouse.123`), null);
  assert.strictEqual(profileDirOf(`${CHROME} --user-data-dir=C:\\proj\\lighthouse.config\\x`), null);
  // user profile followed by an unrelated arg containing lighthouse.<n> must not cross the space
  assert.strictEqual(profileDirOf(`${CHROME} "--user-data-dir=C:\\Users\\e\\AppData\\Local\\Google\\Chrome\\User Data" --app=C:\\foo\\lighthouse.123`), null);
  assert.strictEqual(profileDirOf(`${CHROME} --user-data-dir=C:\\Users\\e\\Chrome\\UserData --app=C:\\foo\\lighthouse.123`), null);
});

console.log('classifyChrome');
test('never touches the user\'s own Chrome', () => {
  const procs = [userMain(100, 50), userChild(101, 100, 'renderer'), userChild(102, 100, 'gpu-process')];
  const { kill, keep } = classifyChrome(procs, { ...OPTS, all: true });
  assert.deepStrictEqual(kill, []);
  assert.deepStrictEqual(keep, []);
});

test('keeps a bot browser whose parent node.exe is alive', () => {
  const procs = [node(500), botMain(600, 500, 1), botChild(601, 600, 1, 'renderer')];
  const { kill, keep } = classifyChrome(procs, OPTS);
  assert.deepStrictEqual(kill, []);
  assert.strictEqual(keep.length, 1);
  assert.strictEqual(keep[0].pid, 600);
});

test('kills an orphan whose parent node.exe is gone — including all its children', () => {
  const procs = [botMain(600, 500, 1), botChild(601, 600, 1, 'renderer'), botChild(602, 600, 1, 'gpu-process')];
  const { kill, keep } = classifyChrome(procs, OPTS);
  assert.deepStrictEqual(kill.map(k => k.pid).sort(), [600, 601, 602]);
  assert.ok(kill.every(k => k.reason === 'orphan'));
  assert.deepStrictEqual(keep, []);
});

test('kills a bot browser whose parent pid was reused by a non-node process', () => {
  const procs = [{ pid: 500, ppid: 4, name: 'chrome.exe', cmd: userMain(500, 4).cmd }, botMain(600, 500, 1)];
  const { kill } = classifyChrome(procs, OPTS);
  assert.deepStrictEqual(kill.map(k => k.pid), [600]);
});

test('kills browsers owned by ownerPid, keeps those owned by another live node', () => {
  const procs = [
    node(500), node(700),
    botMain(600, 500, 1), botChild(601, 600, 1, 'renderer'),
    botMain(800, 700, 2), botChild(801, 800, 2, 'renderer'),
  ];
  const { kill, keep } = classifyChrome(procs, { ...OPTS, ownerPid: 500 });
  assert.deepStrictEqual(kill.map(k => k.pid).sort(), [600, 601]);
  assert.ok(kill.every(k => k.reason === 'owned'));
  assert.deepStrictEqual(keep.map(k => k.pid), [800]);
});

test('all:true kills every bot browser regardless of parent', () => {
  const procs = [node(500), botMain(600, 500, 1), botChild(601, 600, 1, 'renderer'), botMain(800, 999, 2)];
  const { kill, keep } = classifyChrome(procs, { ...OPTS, all: true });
  assert.deepStrictEqual(kill.map(k => k.pid).sort(), [600, 601, 800]);
  assert.deepStrictEqual(keep, []);
});

test('kills leftover children whose browser process is truly gone', () => {
  const procs = [node(500), botChild(601, 600, 1, 'renderer'), botChild(602, 600, 1, 'utility')];
  const { kill } = classifyChrome(procs, OPTS);
  assert.deepStrictEqual(kill.map(k => k.pid).sort(), [601, 602]);
  assert.ok(kill.every(k => k.reason === 'headless-children'));
});

test('does NOT kill helpers whose browser is alive but has an unreadable command line (elevation)', () => {
  const unreadableMain = { pid: 600, ppid: 500, name: 'chrome.exe', cmd: '' };
  const procs = [node(500), unreadableMain, botChild(601, 600, 1, 'renderer'), botChild(602, 600, 1, 'gpu-process')];
  const { kill, keep } = classifyChrome(procs, OPTS);
  assert.deepStrictEqual(kill, []);
  assert.strictEqual(keep.length, 1);
  assert.strictEqual(keep[0].profileDir, `${TMP}\\lighthouse.1`);
});

test('ignores lighthouse profiles outside tmpDir', () => {
  const procs = [botMain(600, 999, 1, 'D:\\somewhere\\else')];
  const { kill, keep } = classifyChrome(procs, OPTS);
  assert.deepStrictEqual(kill, []);
  assert.deepStrictEqual(keep, []);
});

test('tmpDir gate tolerates forward slashes and trailing separators', () => {
  const procs = [node(500), botMain(600, 500, 1, 'C:/Users/eric8/AppData/Local/Temp')];
  const { keep } = classifyChrome(procs, { tmpDir: TMP + '\\' });
  assert.deepStrictEqual(keep.map(k => k.pid), [600]);
  const { keep: keep2 } = classifyChrome([node(500), botMain(600, 500, 1)], { tmpDir: 'C:/Users/eric8/AppData/Local/Temp/' });
  assert.deepStrictEqual(keep2.map(k => k.pid), [600]);
});

test('groups by profile dir case-insensitively', () => {
  const a = botMain(600, 1, 7);
  const b = botChild(601, 600, 7, 'renderer');
  b.cmd = b.cmd.replace('Temp', 'TEMP');
  const { kill } = classifyChrome([a, b], OPTS);
  assert.deepStrictEqual(kill.map(k => k.pid).sort(), [600, 601]);
  assert.strictEqual(new Set(kill.map(k => k.profileDir.toLowerCase())).size, 1);
});

test('crashpad helper is killed together with its orphaned browser', () => {
  const crashpad = { pid: 603, ppid: 600, name: 'chrome.exe', cmd: `${CHROME} --type=crashpad-handler --database=${TMP}\\lighthouse.1\\Crashpad` };
  const procs = [botMain(600, 500, 1), botChild(601, 600, 1, 'renderer'), crashpad];
  const { kill } = classifyChrome(procs, OPTS);
  assert.deepStrictEqual(kill.map(k => k.pid).sort(), [600, 601, 603]);
});

test('mixed machine state: user chrome + live bot + orphan bot', () => {
  const procs = [
    userMain(100, 50), userChild(101, 100, 'renderer'),
    node(500), botMain(600, 500, 1), botChild(601, 600, 1, 'renderer'),
    botMain(800, 999, 2), botChild(801, 800, 2, 'renderer'), botChild(802, 800, 2, 'gpu-process'),
  ];
  const { kill, keep } = classifyChrome(procs, OPTS);
  assert.deepStrictEqual(kill.map(k => k.pid).sort(), [800, 801, 802]);
  assert.deepStrictEqual(keep.map(k => k.pid), [600]);
});

console.log('sweepStaleProfileDirs');
test('sweeps only old, unreferenced lighthouse.<n> dirs', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-test-'));
  const mk = (name, ageMs) => {
    const p = path.join(tmp, name);
    fs.mkdirSync(p);
    const t = new Date(Date.now() - ageMs);
    fs.utimesSync(p, t, t);
    return p;
  };
  const live = mk('lighthouse.11111111', 60 * 60 * 1000);
  const fresh = mk('lighthouse.22222222', 60 * 1000);
  const stale = mk('lighthouse.33333333', 60 * 60 * 1000);
  const notOurs = mk('lighthouse.config', 60 * 60 * 1000);
  const removed = sweepStaleProfileDirs([live], tmp);
  assert.strictEqual(removed, 1);
  assert.ok(fs.existsSync(live), 'live dir kept');
  assert.ok(fs.existsSync(fresh), 'fresh dir kept (mkdir race guard)');
  assert.ok(!fs.existsSync(stale), 'stale dir removed');
  assert.ok(fs.existsSync(notOurs), 'non-matching name kept');
  fs.rmSync(tmp, { recursive: true, force: true });
});

console.log(`\n${passed} passed${process.exitCode ? ' (with failures)' : ''}`);
