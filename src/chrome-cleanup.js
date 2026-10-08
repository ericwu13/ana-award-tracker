/**
 * Chrome cleanup — finds and kills Chrome instances that puppeteer-real-browser
 * launched but nobody closed.
 *
 * Why the old cleanup never worked:
 *   puppeteer-real-browser launches Chrome through `chrome-launcher`, which puts
 *   each profile in `%TEMP%\lighthouse.<8 digits>` and does NOT put the word
 *   "puppeteer" anywhere on the command line. The previous
 *   `CommandLine -match 'puppeteer'` filter therefore matched nothing, so any
 *   Chrome that survived a failed `browser.close()` (CDP timeout, crash, Task
 *   Scheduler kill) sat in the background forever — still rendering the ANA page
 *   and its Akamai sensor scripts, burning GPU.
 *
 *   On a healthy close, puppeteer-real-browser's `disconnected` hook runs
 *   chrome-launcher's kill() + temp-dir removal itself. This module is the
 *   backstop for the unhealthy paths, where that hook never fires.
 *
 * How this works:
 *   1. List every chrome.exe + node.exe with its parent pid and command line.
 *   2. A "bot browser" is a chrome.exe whose --user-data-dir (or crashpad's
 *      --database) points at a lighthouse.<n> profile under %TEMP%. Its main
 *      process is the one without `--type=`.
 *   3. A bot browser is killed when:
 *        - its parent node.exe is gone (orphan — the run that launched it died), or
 *        - its parent is `ownerPid` (the caller's own leftovers, called after the
 *          caller has already tried browser.close()), or
 *        - `all: true` (manual cleanup via `node cleanup-chrome.js --all`).
 *      The user's real Chrome never matches: it doesn't use a lighthouse profile.
 *   4. Every chrome.exe sharing the same profile dir is killed with the main
 *      process (re-verified by name + command line inside the kill pipeline so a
 *      reused pid can't be hit), then the temp profile dir is removed.
 *   5. If the process listing fails for any reason, NOTHING is killed or swept —
 *      an empty listing is not the same as "no bot browsers".
 *
 * `classifyChrome` is pure (no PowerShell) so it can be unit-tested.
 */
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// chrome-launcher profile dirs look like `<tmp>\lighthouse.12345678`. Chrome and
// libuv both quote a whole argument that contains whitespace
// (`"--user-data-dir=C:\Users\John Doe\...\lighthouse.123"`), so accept the
// switch with or without a leading quote. Anchoring on the switch name keeps a
// `lighthouse.<n>` segment in a URL or extension path from matching.
const PROFILE_RE = /(?:^|\s)"?(?:--user-data-dir|--database)=([A-Za-z]:[^"]*?[\\/]lighthouse\.\d+)(?=[\\/"\s]|$)/i;
// Only the unquoted form may not contain spaces (the value ends at the next space).
const PROFILE_RE_UNQUOTED = /(?:^|\s)(?:--user-data-dir|--database)=([A-Za-z]:[^"\s]*?[\\/]lighthouse\.\d+)(?=[\\/\s]|$)/i;

const PS_TIMEOUT_MS = 15000;

/** Extract the lighthouse profile dir from a Chrome command line, or null. */
function profileDirOf(commandLine) {
  if (!commandLine) return null;
  const quoted = /(?:^|\s)"(?:--user-data-dir|--database)=/i.test(commandLine);
  const m = (quoted ? PROFILE_RE : PROFILE_RE_UNQUOTED).exec(commandLine);
  return m ? m[1] : null;
}

function normDir(d) {
  return d.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

/**
 * Decide which Chrome processes to kill.
 *
 * @param {Array<{pid:number, ppid:number, name:string, cmd:string}>} processes
 *   All chrome.exe and node.exe processes on the machine.
 * @param {{ ownerPid?: number, all?: boolean, tmpDir?: string }} opts
 *   tmpDir — if given, only profiles under this directory count as bot browsers.
 * @returns {{ kill: Array<{pid:number, profileDir:string, reason:string}>, keep: Array<{pid:number, profileDir:string}> }}
 */
function classifyChrome(processes, { ownerPid = null, all = false, tmpDir = null } = {}) {
  const byPid = new Map(processes.map(p => [p.pid, p]));
  const isChrome = p => /^chrome\.exe$/i.test(p.name);
  const isNode = p => /^node\.exe$/i.test(p.name);
  const tmpPrefix = tmpDir ? normDir(tmpDir) + '\\' : null;

  // Group bot-browser chrome processes by profile dir
  const groups = new Map(); // profileDir -> { main, members[] }
  for (const p of processes) {
    if (!isChrome(p)) continue;
    const dir = profileDirOf(p.cmd);
    if (!dir) continue;
    const key = normDir(dir);
    if (tmpPrefix && !key.startsWith(tmpPrefix)) continue;
    if (!groups.has(key)) groups.set(key, { profileDir: dir, main: null, members: [] });
    const g = groups.get(key);
    g.members.push(p);
    if (!/\s--type=/.test(p.cmd)) g.main = p;
  }

  const kill = [];
  const keep = [];
  for (const g of groups.values()) {
    let reason = null;
    if (all) {
      reason = 'all';
    } else if (!g.main) {
      // No readable browser process for these helpers. Only treat them as
      // leftovers if their browser pid is truly gone — if it is still running
      // (e.g. its command line is unreadable from this elevation), leave them.
      const browserAlive = g.members.some(m => byPid.has(m.ppid));
      if (!browserAlive) reason = 'headless-children';
    } else {
      const parent = byPid.get(g.main.ppid);
      if (!parent || !isNode(parent)) reason = 'orphan';
      else if (ownerPid != null && g.main.ppid === ownerPid) reason = 'owned';
    }

    if (reason) {
      for (const m of g.members) kill.push({ pid: m.pid, profileDir: g.profileDir, reason });
    } else if (g.main) {
      keep.push({ pid: g.main.pid, profileDir: g.profileDir });
    } else {
      // helpers whose browser is alive but unreadable — keep its profile dir safe
      keep.push({ pid: g.members[0].ppid, profileDir: g.profileDir });
    }
  }
  return { kill, keep };
}

/** Absolute path to Windows PowerShell, so a broken PATH can't silently disable cleanup. */
function powershellPath() {
  const sys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try { if (fs.existsSync(sys)) return sys; } catch {}
  return 'powershell.exe';
}

/** Run a PowerShell script via -EncodedCommand (no shell, no quoting). */
function runPowerShell(script, { timeout = PS_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    execFile(
      powershellPath(),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout) => (err ? reject(err) : resolve(stdout))
    );
  });
}

/**
 * Query chrome.exe + node.exe. Resolves to an array, or null if the listing
 * could not be trusted (error, timeout, unparseable output).
 */
async function listProcesses() {
  if (process.platform !== 'win32') return null;
  const script = `
    $ErrorActionPreference = 'Stop'
    $p = Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='node.exe'" |
      Select-Object ProcessId, ParentProcessId, Name, CommandLine
    @{ ok = $true; procs = @($p) } | ConvertTo-Json -Compress -Depth 3
  `;
  try {
    const out = (await runPowerShell(script)).trim();
    const parsed = JSON.parse(out);
    if (!parsed || parsed.ok !== true || !Array.isArray(parsed.procs)) return null;
    const procs = parsed.procs.filter(Boolean).map(r => ({
      pid: Number(r.ProcessId),
      ppid: Number(r.ParentProcessId),
      name: String(r.Name || ''),
      cmd: String(r.CommandLine || ''),
    }));
    // Sanity invariant: the calling process must itself be in the listing as
    // node.exe. If it isn't, the WMI answer is incomplete or our "parent is
    // node.exe" assumption doesn't hold on this host — treat as untrusted.
    if (!procs.some(p => p.pid === process.pid && /^node\.exe$/i.test(p.name))) return null;
    return procs;
  } catch {
    return null;
  }
}

/**
 * Kill pids, but only those that are still a chrome.exe with a lighthouse
 * profile on their command line at kill time (guards against pid reuse).
 */
async function killBotChrome(pids) {
  if (pids.length === 0) return;
  const filter = pids.map(p => `ProcessId=${Number(p)}`).join(' OR ');
  const script = `
    Get-CimInstance Win32_Process -Filter "${filter}" |
      Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -match '[\\\\/]lighthouse\\.\\d+' } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  `;
  try { await runPowerShell(script); } catch {}
}

/** Remove a lighthouse temp profile dir under tmpDir. Best-effort. */
function removeProfileDir(dir, tmpDir) {
  try {
    const key = normDir(dir);
    if (!key.startsWith(normDir(tmpDir) + '\\')) return;
    if (/\\lighthouse\.\d+$/i.test(key) && fs.existsSync(dir)) {
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
 * Only called with a trusted `liveDirs` list (see cleanupChrome).
 */
function sweepStaleProfileDirs(liveDirs, tmpDir, now = Date.now()) {
  const live = new Set(liveDirs.map(normDir));
  let removed = 0;
  try {
    for (const name of fs.readdirSync(tmpDir)) {
      if (!/^lighthouse\.\d+$/i.test(name)) continue;
      const full = path.join(tmpDir, name);
      if (live.has(normDir(full))) continue;
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
 * Async and non-blocking; never throws.
 *
 * @param {{ ownerPid?: number, all?: boolean, sweep?: boolean, log?: Function }} opts
 *   ownerPid — also kill browsers whose parent is this pid (call AFTER browser.close()).
 *   all      — kill every lighthouse-profile Chrome regardless of parent.
 *   sweep    — also delete stale %TEMP%\lighthouse.* dirs (default true).
 * @returns {Promise<{ ok: boolean, killed: number, kept: number, sweptDirs: number }>}
 *   ok=false means the process listing failed and nothing was touched.
 */
async function cleanupChrome({ ownerPid = null, all = false, sweep = true, log = console.log } = {}) {
  const result = { ok: false, killed: 0, kept: 0, sweptDirs: 0 };
  if (process.platform !== 'win32') return result;

  const tmpDir = os.tmpdir();
  const processes = await listProcesses();
  if (!processes) {
    log('[ChromeCleanup] Could not list processes — skipping cleanup this time');
    return result;
  }
  result.ok = true;

  const { kill, keep } = classifyChrome(processes, { ownerPid, all, tmpDir });
  result.killed = kill.length;
  result.kept = keep.length;

  if (kill.length > 0) {
    const byReason = {};
    for (const k of kill) byReason[k.reason] = (byReason[k.reason] || 0) + 1;
    log(`[ChromeCleanup] Killing ${kill.length} bot Chrome process(es): ${JSON.stringify(byReason)}`);
    await killBotChrome(kill.map(k => k.pid));
    for (const dir of new Set(kill.map(k => k.profileDir))) removeProfileDir(dir, tmpDir);
  }

  if (sweep) {
    result.sweptDirs = sweepStaleProfileDirs(keep.map(k => k.profileDir), tmpDir);
    if (result.sweptDirs > 0) log(`[ChromeCleanup] Removed ${result.sweptDirs} stale temp profile dir(s)`);
  }
  return result;
}

module.exports = { cleanupChrome, classifyChrome, profileDirOf, listProcesses, sweepStaleProfileDirs };
