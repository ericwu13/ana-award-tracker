/**
 * Chrome cleanup — finds and kills Chrome instances that puppeteer-real-browser
 * launched but nobody closed.
 *
 * Why the old cleanup never worked:
 *   puppeteer-real-browser launches Chrome through `chrome-launcher`, which puts
 *   each profile in `%TEMP%\lighthouse.<random>` and does NOT put the word
 *   "puppeteer" anywhere on the command line. The previous
 *   `CommandLine -match 'puppeteer'` filter therefore matched nothing, so any
 *   Chrome that survived a failed `browser.close()` (CDP timeout, crash, Task
 *   Scheduler kill) sat in the background forever — still rendering the ANA page
 *   and its Akamai sensor scripts, burning GPU.
 *
 * How this works:
 *   1. List every chrome.exe + node.exe with its parent pid and command line.
 *   2. A "bot browser" is a chrome.exe whose --user-data-dir points at a
 *      lighthouse.* profile. Its main process is the one without `--type=`.
 *   3. A bot browser is killed when:
 *        - its parent node.exe is gone (orphan — the run that launched it died), or
 *        - its parent is `ownerPid` (the caller's own leftovers, called after the
 *          caller has already tried browser.close()), or
 *        - `all: true` (manual cleanup via `node cleanup-chrome.js --all`).
 *      The user's real Chrome never matches: it doesn't use a lighthouse profile.
 *   4. Every chrome.exe sharing the same profile dir is killed with the main
 *      process, then the temp profile dir is removed.
 *
 * `classifyChrome` is pure (no PowerShell) so it can be unit-tested.
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// chrome-launcher profile dirs look like `<tmp>\lighthouse.12345678`. Match the
// path up to and including that segment, quoted or not. We don't anchor on
// `--user-data-dir=` because helper processes (e.g. `--type=crashpad-handler
// --database=<profile>\Crashpad`) reference the dir through other switches.
// Both forms must start at a drive letter so the closing quote of the chrome.exe
// path can't be mistaken for the start of a quoted argument.
const PROFILE_RE = /(?:"([A-Za-z]:[^"]*?[\\/]lighthouse\.\d+)(?=[\\/"])|(?:^|[\s=])([A-Za-z]:[^"\s]*?[\\/]lighthouse\.\d+)(?=[\\/"\s]|$))/i;

/** Extract the lighthouse profile dir from a Chrome command line, or null. */
function profileDirOf(commandLine) {
  if (!commandLine) return null;
  const m = PROFILE_RE.exec(commandLine);
  if (!m) return null;
  return m[1] || m[2];
}

/**
 * Decide which Chrome processes to kill.
 *
 * @param {Array<{pid:number, ppid:number, name:string, cmd:string}>} processes
 *   All chrome.exe and node.exe processes on the machine.
 * @param {{ ownerPid?: number, all?: boolean }} opts
 * @returns {{ kill: Array<{pid:number, profileDir:string, reason:string}>, keep: Array<{pid:number, profileDir:string}> }}
 */
function classifyChrome(processes, { ownerPid = null, all = false } = {}) {
  const byPid = new Map(processes.map(p => [p.pid, p]));
  const isChrome = p => /^chrome\.exe$/i.test(p.name);
  const isNode = p => /^node\.exe$/i.test(p.name);

  // Group bot-browser chrome processes by profile dir
  const groups = new Map(); // profileDir -> { main, members[] }
  for (const p of processes) {
    if (!isChrome(p)) continue;
    const dir = profileDirOf(p.cmd);
    if (!dir) continue;
    const key = dir.toLowerCase();
    if (!groups.has(key)) groups.set(key, { profileDir: dir, main: null, members: [] });
    const g = groups.get(key);
    g.members.push(p);
    if (!/--type=/.test(p.cmd)) g.main = p;
  }

  const kill = [];
  const keep = [];
  for (const g of groups.values()) {
    let reason = null;
    if (all) {
      reason = 'all';
    } else if (!g.main) {
      // Only renderers/GPU helpers left — browser process already died
      reason = 'headless-children';
    } else {
      const parent = byPid.get(g.main.ppid);
      if (!parent || !isNode(parent)) reason = 'orphan';
      else if (ownerPid != null && g.main.ppid === ownerPid) reason = 'owned';
    }

    if (reason) {
      for (const m of g.members) kill.push({ pid: m.pid, profileDir: g.profileDir, reason });
    } else {
      keep.push({ pid: g.main.pid, profileDir: g.profileDir });
    }
  }
  return { kill, keep };
}

/** Query chrome.exe + node.exe via PowerShell. Returns [] on any failure. */
function listProcesses() {
  if (process.platform !== 'win32') return [];
  const ps = [
    "Get-CimInstance Win32_Process -Filter \\\"Name='chrome.exe' OR Name='node.exe'\\\"",
    '| Select-Object ProcessId, ParentProcessId, Name, CommandLine',
    '| ConvertTo-Json -Compress',
  ].join(' ');
  try {
    const out = execSync(`powershell -NoProfile -NonInteractive -Command "${ps}"`, {
      encoding: 'utf8', timeout: 20000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 16 * 1024 * 1024,
    }).trim();
    if (!out) return [];
    const parsed = JSON.parse(out);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.map(r => ({
      pid: Number(r.ProcessId),
      ppid: Number(r.ParentProcessId),
      name: String(r.Name || ''),
      cmd: String(r.CommandLine || ''),
    }));
  } catch {
    return [];
  }
}

function killPids(pids) {
  if (pids.length === 0) return;
  try {
    execSync(
      `powershell -NoProfile -NonInteractive -Command "Stop-Process -Id ${pids.join(',')} -Force -ErrorAction SilentlyContinue"`,
      { timeout: 20000, windowsHide: true, stdio: 'ignore' }
    );
  } catch {}
}

/** Remove a lighthouse temp profile dir. Best-effort. */
function removeProfileDir(dir) {
  try {
    if (/[\\/]lighthouse\.\d+$/i.test(dir) && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    }
  } catch {}
}

// A profile dir younger than this is left alone even if no chrome.exe references
// it yet: chrome-launcher mkdirs the profile a moment before spawning Chrome, and
// another process (keep-alive vs run-once) could sweep in that window.
const SWEEP_MIN_AGE_MS = 10 * 60 * 1000;

/**
 * Sweep leftover %TEMP%\lighthouse.* dirs that no running Chrome uses.
 * Each one is ~100-300 MB of cache; chrome-launcher only deletes them on a clean kill().
 */
function sweepStaleProfileDirs(liveDirs, now = Date.now()) {
  const live = new Set(liveDirs.map(d => d.toLowerCase()));
  let removed = 0;
  try {
    const tmp = os.tmpdir();
    for (const name of fs.readdirSync(tmp)) {
      if (!/^lighthouse\.\d+$/i.test(name)) continue;
      const full = path.join(tmp, name);
      if (live.has(full.toLowerCase())) continue;
      try {
        if (now - fs.statSync(full).mtimeMs < SWEEP_MIN_AGE_MS) continue;
      } catch { continue; }
      try {
        fs.rmSync(full, { recursive: true, force: true, maxRetries: 3 });
        removed++;
      } catch {}
    }
  } catch {}
  return removed;
}

/**
 * Kill orphaned / owned / all bot Chrome instances and clean their temp profiles.
 *
 * @param {{ ownerPid?: number, all?: boolean, sweep?: boolean, log?: Function }} opts
 *   ownerPid — also kill browsers whose parent is this pid (call AFTER browser.close()).
 *   all      — kill every lighthouse-profile Chrome regardless of parent.
 *   sweep    — also delete stale %TEMP%\lighthouse.* dirs (default true).
 * @returns {{ killed: number, kept: number, sweptDirs: number }}
 */
function cleanupChrome({ ownerPid = null, all = false, sweep = true, log = console.log } = {}) {
  if (process.platform !== 'win32') return { killed: 0, kept: 0, sweptDirs: 0 };

  const processes = listProcesses();
  const { kill, keep } = classifyChrome(processes, { ownerPid, all });

  if (kill.length > 0) {
    const byReason = {};
    for (const k of kill) byReason[k.reason] = (byReason[k.reason] || 0) + 1;
    log(`[ChromeCleanup] Killing ${kill.length} bot Chrome process(es): ${JSON.stringify(byReason)}`);
    killPids(kill.map(k => k.pid));
    for (const dir of new Set(kill.map(k => k.profileDir))) removeProfileDir(dir);
  }

  let sweptDirs = 0;
  if (sweep) sweptDirs = sweepStaleProfileDirs(keep.map(k => k.profileDir));
  if (sweptDirs > 0) log(`[ChromeCleanup] Removed ${sweptDirs} stale temp profile dir(s)`);

  return { killed: kill.length, kept: keep.length, sweptDirs };
}

module.exports = { cleanupChrome, classifyChrome, profileDirOf, listProcesses };
