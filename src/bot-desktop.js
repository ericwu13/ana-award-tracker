/**
 * Hidden desktop for bot processes — BOT_DESKTOP=<name>.
 *
 * An off-screen --window-position (src/browser-window.js) hides the main Chrome
 * window but not everything Chrome creates: each bot window still gets a taskbar
 * button and an Alt-Tab entry, and bubbles/popups are repositioned by Chromium
 * onto the nearest real monitor. Running the bot on a separate Win32 desktop of
 * the same interactive window station removes all of that at once: that desktop
 * has no taskbar, is never the input desktop, and nothing on it can be drawn on
 * or take focus from the user's desktop.
 *
 * It is NOT headless and NOT session 0: same logon session, same GPU, same
 * monitors. Measured against an off-screen window on the normal desktop the page
 * is indistinguishable — 60 fps rAF, visibilityState "visible", identical WebGL
 * renderer string, screen.*, devicePixelRatio and screenX/Y.
 *
 * How: a process's desktop is fixed at CreateProcess time and inherited by its
 * children, so the entry scripts (run-once.js, discord-bot.js) re-launch
 * themselves once through tools/desktop-launch.cs and every Chrome they spawn
 * follows. The original process stays as a thin waiter so Task Scheduler still
 * sees the task running and stdout redirection keeps working.
 *
 * Fail-open: if the launcher can't be built or can't start the command, the
 * script carries on on the normal desktop — a visible window beats a dead bot.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const LAUNCHER_SRC = path.join(ROOT, 'tools', 'desktop-launch.cs');
const LAUNCHER_EXE = path.join(ROOT, 'data', 'bin', 'desktop-launch.exe');
const ACTIVE_VAR = 'BOT_DESKTOP_ACTIVE';
// Keep in sync with EXIT_NOT_STARTED in tools/desktop-launch.cs.
const EXIT_NOT_STARTED = 113;
const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

/** The configured desktop name, or null when unset / invalid. */
function resolveDesktop(env = process.env, log = null) {
  const raw = (env.BOT_DESKTOP || '').trim();
  if (!raw) return null;
  if (!NAME_RE.test(raw)) {
    if (log) log(`BOT_DESKTOP=${JSON.stringify(raw)} is not a valid desktop name (letters, digits, _ or -) — using the normal desktop`);
    return null;
  }
  return raw;
}

/**
 * The desktop this process should re-launch itself onto, or null if it should
 * just keep running (not Windows, not configured, or already there).
 */
function desktopToRelaunchOn(env = process.env, platform = process.platform, log = null) {
  if (platform !== 'win32') return null;
  const name = resolveDesktop(env, log);
  if (!name || env[ACTIVE_VAR] === name) return null;
  return name;
}

/** Build data/bin/desktop-launch.exe if it is missing or older than its source. */
function ensureLauncher() {
  const srcTime = fs.statSync(LAUNCHER_SRC).mtimeMs;
  if (fs.existsSync(LAUNCHER_EXE) && fs.statSync(LAUNCHER_EXE).mtimeMs >= srcTime) return LAUNCHER_EXE;

  const windir = process.env.WINDIR || 'C:\\Windows';
  const csc = ['Framework64', 'Framework']
    .map(dir => path.join(windir, 'Microsoft.NET', dir, 'v4.0.30319', 'csc.exe'))
    .find(p => fs.existsSync(p));
  if (!csc) throw new Error('csc.exe (.NET Framework 4) not found');

  fs.mkdirSync(path.dirname(LAUNCHER_EXE), { recursive: true });
  // Compile to a temp name and rename, so a concurrent start never runs a half-written exe.
  const tmp = `${LAUNCHER_EXE}.${process.pid}.tmp`;
  const res = spawnSync(csc, ['/nologo', '/optimize', '/target:exe', `/out:${tmp}`, LAUNCHER_SRC], { encoding: 'utf8', windowsHide: true });
  if (res.status !== 0 || !fs.existsSync(tmp)) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw new Error(`csc failed: ${(res.stdout || res.stderr || res.error || '').toString().trim().slice(0, 300)}`);
  }
  try {
    fs.renameSync(tmp, LAUNCHER_EXE);
  } catch (e) {
    // The existing exe is in use (another bot process is running through it) — keep using it.
    try { fs.unlinkSync(tmp); } catch (_) {}
    if (!fs.existsSync(LAUNCHER_EXE)) throw e;
  }
  return LAUNCHER_EXE;
}

/**
 * Call first thing in an entry script. If BOT_DESKTOP is set and this process is
 * not on that desktop yet, re-runs the script there, waits for it, and exits
 * with its exit code — this call then never returns. Otherwise returns false
 * and the script continues normally.
 *
 * @param {string} tag  log prefix, e.g. '[run-once]'
 */
function relaunchOnBotDesktop(tag) {
  const log = msg => console.log(`${tag} ${msg}`);
  const name = desktopToRelaunchOn(process.env, process.platform, log);
  if (!name) return false;

  let launcher;
  try {
    launcher = ensureLauncher();
  } catch (e) {
    log(`BOT_DESKTOP: launcher unavailable (${e.message}) — running on the normal desktop`);
    return false;
  }

  const res = spawnSync(launcher, ['run', name, process.execPath, ...process.execArgv, ...process.argv.slice(1)], {
    stdio: 'inherit',
    windowsHide: true,
    env: { ...process.env, [ACTIVE_VAR]: name },
  });
  if (res.error || res.status === EXIT_NOT_STARTED) {
    log(`BOT_DESKTOP: could not start on desktop "${name}" (${res.error ? res.error.message : 'launcher refused'}) — running on the normal desktop`);
    return false;
  }
  process.exit(res.status == null ? 1 : res.status);
}

/** Visible top-level windows on the bot desktop, as text (diagnostics). */
function listDesktopWindows(name = resolveDesktop()) {
  if (!name) return 'BOT_DESKTOP is not set';
  const res = spawnSync(ensureLauncher(), ['list', name], { encoding: 'utf8', windowsHide: true });
  return (res.stdout || '') + (res.stderr || '');
}

module.exports = { resolveDesktop, desktopToRelaunchOn, ensureLauncher, relaunchOnBotDesktop, listDesktopWindows, ACTIVE_VAR, EXIT_NOT_STARTED, LAUNCHER_EXE };
