/**
 * Bot browser window placement — keep headful Chrome off the user's screen.
 *
 * Why not headless:
 *   ANA's Akamai Bot Manager fingerprints the browser (WebGL renderer, screen
 *   metrics, ...). The session cookies come from the user's real Chrome on the
 *   same GPU; a headless or session-0 Chrome reports a different renderer and
 *   is far more likely to be flagged, which stalls the whole bot (markStale).
 *
 * Why `--window-position` off-screen and `--start-minimized` don't work:
 *   Chromium clamps a new window so that part of it stays on a display, and
 *   `--start-minimized` is not a Chrome switch (only --start-maximized /
 *   --start-fullscreen exist), so both were no-ops.
 *
 * What this does instead:
 *   Right after puppeteer connects, ask Chrome over CDP to minimize the window
 *   (`Browser.setWindowBounds { windowState: 'minimized' }`). The page keeps
 *   running at full speed (chrome-launcher's default flags include
 *   --disable-backgrounding-occluded-windows), CDP input events don't need a
 *   visible window, and Chrome doesn't composite a minimized window, so the
 *   GPU stays idle while the bot runs.
 *
 * Caveats:
 *   - `document.visibilityState` becomes 'hidden' in a minimized window. Whether
 *     Akamai's sensor treats that as a signal is unknown, so this is gated by
 *     BOT_MINIMIZE_WINDOWS and should be rolled out keep-alive first.
 *   - `page.screenshot()` can fail on a minimized window. Every screenshot in
 *     this codebase is already inside try/catch.
 *   - The window still flashes for a moment while Chrome starts, before CDP is up.
 *
 * Config: BOT_MINIMIZE_WINDOWS = off (default) | keepalive | all
 */

const SCOPES = new Set(['off', 'keepalive', 'all']);

/**
 * Normalise the BOT_MINIMIZE_WINDOWS env value.
 * @param {string|undefined} raw
 * @returns {'off'|'keepalive'|'all'}
 */
function resolveMinimizeScope(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (SCOPES.has(v)) return v;
  if (['1', 'true', 'yes', 'on'].includes(v)) return 'all';
  return 'off';
}

/**
 * @param {'off'|'keepalive'|'all'} scope
 * @param {'keepalive'|'search'} role
 */
function shouldMinimize(scope, role) {
  if (scope === 'all') return true;
  if (scope === 'keepalive') return role === 'keepalive';
  return false;
}

/**
 * Minimize the Chrome window that hosts `page`. Never throws; resolves true on
 * success, false otherwise. Bounded by `timeoutMs` so a wedged CDP can't stall
 * the caller.
 *
 * @param {import('puppeteer').Page} page
 * @param {{ log?: Function, timeoutMs?: number }} [opts]
 */
async function minimizeWindow(page, { log = () => {}, timeoutMs = 5000 } = {}) {
  let client = null;
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`minimizeWindow timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    const work = (async () => {
      client = await page.createCDPSession();
      const { windowId } = await client.send('Browser.getWindowForTarget');
      await client.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
      return true;
    })();
    const ok = await Promise.race([work, timeout]);
    log('Window minimized');
    return ok;
  } catch (e) {
    log(`Could not minimize window: ${e.message}`);
    return false;
  } finally {
    clearTimeout(timer);
    if (client) { try { await client.detach(); } catch {} }
  }
}

/**
 * Convenience: read the env, decide for `role`, and minimize if enabled.
 * @returns {Promise<boolean>} whether a minimize was attempted and succeeded
 */
async function applyWindowPolicy(page, role, { log, env = process.env } = {}) {
  const scope = resolveMinimizeScope(env.BOT_MINIMIZE_WINDOWS);
  if (!shouldMinimize(scope, role)) return false;
  return minimizeWindow(page, { log });
}

module.exports = { resolveMinimizeScope, shouldMinimize, minimizeWindow, applyWindowPolicy };
