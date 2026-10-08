/**
 * Tests for src/chrome-cleanup.js — classification of bot Chrome processes.
 * Run: node test/chrome-cleanup.test.js
 */
const assert = require('assert');
const { classifyChrome, profileDirOf } = require('../src/chrome-cleanup');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

const TMP = 'C:\\Users\\eric8\\AppData\\Local\\Temp';
const CHROME = '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"';

function botMain(pid, ppid, n) {
  return { pid, ppid, name: 'chrome.exe', cmd: `${CHROME} --disable-features=Translate,AutomationControlled --remote-debugging-port=51234 --user-data-dir=${TMP}\\lighthouse.${n} --start-minimized --no-sandbox` };
}
function botChild(pid, ppid, n, type) {
  return { pid, ppid, name: 'chrome.exe', cmd: `${CHROME} --type=${type} --user-data-dir=${TMP}\\lighthouse.${n} --mojo-platform-channel-handle=1234` };
}
function userMain(pid, ppid) {
  return { pid, ppid, name: 'chrome.exe', cmd: `${CHROME} --flag-switches-begin --flag-switches-end` };
}
function userChild(pid, ppid, type) {
  return { pid, ppid, name: 'chrome.exe', cmd: `${CHROME} --type=${type} --user-data-dir="C:\\Users\\eric8\\AppData\\Local\\Google\\Chrome\\User Data"` };
}
const node = (pid, ppid = 4) => ({ pid, ppid, name: 'node.exe', cmd: 'node run-once.js' });

console.log('profileDirOf');
test('extracts unquoted lighthouse dir', () => {
  assert.strictEqual(profileDirOf(botMain(1, 2, 123).cmd), `${TMP}\\lighthouse.123`);
});
test('extracts quoted lighthouse dir', () => {
  assert.strictEqual(profileDirOf(`${CHROME} --user-data-dir="C:\\T mp\\lighthouse.999" --x`), 'C:\\T mp\\lighthouse.999');
});
test('ignores the user\'s real profile', () => {
  assert.strictEqual(profileDirOf(userChild(1, 2, 'renderer').cmd), null);
  assert.strictEqual(profileDirOf(userMain(1, 2).cmd), null);
});
test('null/empty command line', () => {
  assert.strictEqual(profileDirOf(null), null);
  assert.strictEqual(profileDirOf(''), null);
});
test('crashpad handler references the profile via --database, not --user-data-dir', () => {
  const cmd = `${CHROME} --type=crashpad-handler "--user-data-dir=${TMP}\\lighthouse.555" /prefetch:4 --database=${TMP}\\lighthouse.555\\Crashpad --url=https://clients2.google.com/cr/report`;
  assert.strictEqual(profileDirOf(cmd), `${TMP}\\lighthouse.555`);
  const cmd2 = `${CHROME} --type=crashpad-handler --database=${TMP}\\lighthouse.555\\Crashpad`;
  assert.strictEqual(profileDirOf(cmd2), `${TMP}\\lighthouse.555`);
});
test('does not match lighthouse-like text that is not a chrome-launcher profile', () => {
  assert.strictEqual(profileDirOf(`${CHROME} --user-data-dir=C:\\proj\\lighthouse.config\\x`), null);
  assert.strictEqual(profileDirOf(`${CHROME} https://lighthouse.example.com/lighthouse.html`), null);
});

console.log('classifyChrome');
test('never touches the user\'s own Chrome', () => {
  const procs = [userMain(100, 50), userChild(101, 100, 'renderer'), userChild(102, 100, 'gpu-process')];
  const { kill, keep } = classifyChrome(procs, { all: true });
  assert.deepStrictEqual(kill, []);
  assert.deepStrictEqual(keep, []);
});

test('keeps a bot browser whose parent node.exe is alive', () => {
  const procs = [node(500), botMain(600, 500, 1), botChild(601, 600, 1, 'renderer')];
  const { kill, keep } = classifyChrome(procs);
  assert.deepStrictEqual(kill, []);
  assert.strictEqual(keep.length, 1);
  assert.strictEqual(keep[0].pid, 600);
});

test('kills an orphan whose parent node.exe is gone — including all its children', () => {
  const procs = [botMain(600, 500, 1), botChild(601, 600, 1, 'renderer'), botChild(602, 600, 1, 'gpu-process')];
  const { kill, keep } = classifyChrome(procs);
  assert.deepStrictEqual(kill.map(k => k.pid).sort(), [600, 601, 602]);
  assert.ok(kill.every(k => k.reason === 'orphan'));
  assert.deepStrictEqual(keep, []);
});

test('kills a bot browser whose parent pid was reused by a non-node process', () => {
  const procs = [{ pid: 500, ppid: 4, name: 'chrome.exe', cmd: userMain(500, 4).cmd }, botMain(600, 500, 1)];
  const { kill } = classifyChrome(procs);
  assert.deepStrictEqual(kill.map(k => k.pid), [600]);
});

test('kills browsers owned by ownerPid, keeps those owned by another live node', () => {
  const procs = [
    node(500), node(700),
    botMain(600, 500, 1), botChild(601, 600, 1, 'renderer'),
    botMain(800, 700, 2), botChild(801, 800, 2, 'renderer'),
  ];
  const { kill, keep } = classifyChrome(procs, { ownerPid: 500 });
  assert.deepStrictEqual(kill.map(k => k.pid).sort(), [600, 601]);
  assert.ok(kill.every(k => k.reason === 'owned'));
  assert.deepStrictEqual(keep.map(k => k.pid), [800]);
});

test('all:true kills every bot browser regardless of parent', () => {
  const procs = [node(500), botMain(600, 500, 1), botChild(601, 600, 1, 'renderer'), botMain(800, 999, 2)];
  const { kill, keep } = classifyChrome(procs, { all: true });
  assert.deepStrictEqual(kill.map(k => k.pid).sort(), [600, 601, 800]);
  assert.deepStrictEqual(keep, []);
});

test('kills leftover children whose browser process already died', () => {
  const procs = [node(500), botChild(601, 600, 1, 'renderer'), botChild(602, 600, 1, 'utility')];
  const { kill } = classifyChrome(procs);
  assert.deepStrictEqual(kill.map(k => k.pid).sort(), [601, 602]);
  assert.ok(kill.every(k => k.reason === 'headless-children'));
});

test('groups by profile dir case-insensitively', () => {
  const a = botMain(600, 1, 7);
  const b = botChild(601, 600, 7, 'renderer');
  b.cmd = b.cmd.replace('Temp', 'TEMP');
  const { kill } = classifyChrome([a, b]);
  assert.deepStrictEqual(kill.map(k => k.pid).sort(), [600, 601]);
  assert.strictEqual(new Set(kill.map(k => k.profileDir)).size, 1);
});

test('crashpad helper is killed together with its orphaned browser', () => {
  const crashpad = { pid: 603, ppid: 600, name: 'chrome.exe', cmd: `${CHROME} --type=crashpad-handler --database=${TMP}\\lighthouse.1\\Crashpad` };
  const procs = [botMain(600, 500, 1), botChild(601, 600, 1, 'renderer'), crashpad];
  const { kill } = classifyChrome(procs);
  assert.deepStrictEqual(kill.map(k => k.pid).sort(), [600, 601, 603]);
});

test('mixed machine state: user chrome + live bot + orphan bot', () => {
  const procs = [
    userMain(100, 50), userChild(101, 100, 'renderer'),
    node(500), botMain(600, 500, 1), botChild(601, 600, 1, 'renderer'),
    botMain(800, 999, 2), botChild(801, 800, 2, 'renderer'), botChild(802, 800, 2, 'gpu-process'),
  ];
  const { kill, keep } = classifyChrome(procs);
  assert.deepStrictEqual(kill.map(k => k.pid).sort(), [800, 801, 802]);
  assert.deepStrictEqual(keep.map(k => k.pid), [600]);
});

console.log(`\n${passed} passed${process.exitCode ? ' (with failures)' : ''}`);
