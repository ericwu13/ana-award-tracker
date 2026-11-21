/**
 * Decides whether the puppeteer keep-alive can skip a tick because a search
 * cycle (run-once.js) is exercising the ANA session anyway.
 *
 * Every search session navigates 0771 → aswbe-i.ana.co.jp with the same
 * cookies the keep-alive would use, which refreshes the server-side session
 * exactly like the keep-alive does. So a keep-alive Chrome launched while a
 * search is running (a third concurrent bot Chrome, same machine, same
 * account) or right after one succeeded is pure load. Skipping it never skips
 * the re-auth path for long: the next tick outside the window runs normally.
 *
 * KEEPALIVE_SKIP_AFTER_RUN_MIN (default 30): skip if the last search cycle
 * finished with checked > 0 within this many minutes. 0 disables all skipping
 * (keep-alive behaves exactly as before).
 *
 * Two backstops keep the gate from starving the keep-alive:
 * - A search session does NOT write rotated cookies (_abck etc.) back to
 *   cookies.json; only the keep-alive does. So we never skip when the last
 *   keep-alive success is older than KEEPALIVE_MAX_SKIP_MIN (default 60), or
 *   unknown (first tick after the bot starts). This matters when the Chrome
 *   extension is down and the keep-alive is the only cookie refresher.
 * - A run.lock older than STALE_LOCK_MS (2 h) is ignored: a hard-killed
 *   run-once leaves its lock behind and Windows reuses PIDs quickly.
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DEFAULT_WINDOW_MIN = 30;
const DEFAULT_MAX_SKIP_MIN = 60;
const STALE_LOCK_MS = 2 * 60 * 60 * 1000;

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; } // exists but not ours
}

/**
 * @returns {string|null} a human-readable reason to skip, or null to run
 */
function keepAliveSkipReason({
  env = process.env,
  now = Date.now(),
  lockFile = path.join(DATA_DIR, 'run.lock'),
  stateFile = path.join(DATA_DIR, 'state.json'),
  isAlive = pidAlive,
  lastKeepAliveSuccess = null, // ms epoch of the last keep-alive success, or null
} = {}) {
  const raw = env.KEEPALIVE_SKIP_AFTER_RUN_MIN;
  let windowMin = raw == null || String(raw).trim() === '' ? DEFAULT_WINDOW_MIN : Number(raw);
  if (!Number.isFinite(windowMin) || windowMin < 0) windowMin = DEFAULT_WINDOW_MIN;
  if (windowMin === 0) return null;

  const rawMax = env.KEEPALIVE_MAX_SKIP_MIN;
  let maxSkipMin = rawMax == null || String(rawMax).trim() === '' ? DEFAULT_MAX_SKIP_MIN : Number(rawMax);
  if (!Number.isFinite(maxSkipMin) || maxSkipMin <= 0) maxSkipMin = DEFAULT_MAX_SKIP_MIN;
  if (!Number.isFinite(lastKeepAliveSuccess)) return null;
  const sinceKeepAliveMin = (now - lastKeepAliveSuccess) / 60000;
  if (sinceKeepAliveMin < 0 || sinceKeepAliveMin >= maxSkipMin) return null;

  // 1. A search cycle is running right now (run-once.js holds run.lock).
  try {
    const lockAge = now - fs.statSync(lockFile).mtimeMs;
    const pid = parseInt(fs.readFileSync(lockFile, 'utf8').trim(), 10);
    if (lockAge < STALE_LOCK_MS && pid > 0 && isAlive(pid)) return `search cycle in progress (PID ${pid})`;
  } catch (_) { /* no lock / unreadable — fall through */ }

  // 2. A search cycle finished recently and actually reached the search form.
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const cov = state && state.lastCoverage;
    const ts = cov && Date.parse(cov.timestamp);
    if (cov && cov.checked > 0 && Number.isFinite(ts)) {
      const ageMin = (now - ts) / 60000;
      if (ageMin >= 0 && ageMin < windowMin) {
        return `last search cycle succeeded ${Math.round(ageMin)} min ago (${cov.checked} checked)`;
      }
    }
  } catch (_) { /* no state yet — run the keep-alive */ }

  return null;
}

module.exports = { keepAliveSkipReason, DEFAULT_WINDOW_MIN, DEFAULT_MAX_SKIP_MIN, STALE_LOCK_MS };
