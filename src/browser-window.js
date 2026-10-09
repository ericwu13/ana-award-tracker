/**
 * Bot browser window placement — keep headful Chrome off the user's screen.
 *
 * Why not headless / session 0:
 *   ANA's Akamai Bot Manager fingerprints the browser (WebGL renderer, screen
 *   metrics, ...). The session cookies come from the user's real Chrome on the
 *   same GPU; a headless or non-interactive-session Chrome reports a different
 *   renderer and is far more likely to be flagged, which stalls the bot.
 *
 * Why not minimize (CDP Browser.setWindowBounds windowState=minimized):
 *   On Windows a minimized window is HIDDEN to the renderer, so BeginMainFrame
 *   stops: puppeteer's click() (IntersectionObserver) never resolves,
 *   waitForFunction's rAF polling evaluates once, and every mouse.move waits on
 *   a 5 s fallback timer. The bot breaks before Akamai even gets a vote.
 *
 * What works: an off-screen --window-position.
 *   Chromium applies a command-line --window-position verbatim (no clamp onto a
 *   display), and chrome-launcher's default flags disable native window
 *   occlusion tracking and occluded-window backgrounding, so a window placed
 *   outside the virtual desktop stays VISIBLE to the renderer: rAF, clicks,
 *   mouse input and visibilityState are identical to an on-screen window. The
 *   old hard-coded -1920 / -2560 positions were "off-screen" only for a single
 *   1080p monitor; on a multi-monitor desktop they land on the left display.
 *
 * Config: BOT_WINDOW_POSITION = "x,y"  (unset = legacy positions, no change)
 *   Recommended: -32000,-32000 — outside any realistic virtual desktop.
 *   Search sessions are offset by +320px per session id so they don't overlap.
 */

// Exactly what master produced: keep-alive at -2560, search session N at
// -1920 + N*320 (so session 1 = -1600, session 2 = -1280).
const LEGACY = {
  keepalive: { x: -2560, y: 679 },
  search: { x: -1600, y: 679 },
};
const SEARCH_STAGGER_PX = 320;

/**
 * Parse "x,y". Returns null for unset / malformed values.
 * @param {string|undefined} raw
 * @returns {{x:number, y:number}|null}
 */
function parseWindowPosition(raw) {
  if (raw == null) return null;
  const m = /^\s*(-?\d{1,6})\s*,\s*(-?\d{1,6})\s*$/.exec(String(raw));
  if (!m) return null;
  return { x: parseInt(m[1], 10), y: parseInt(m[2], 10) };
}

/**
 * Resolve the window position for a bot browser.
 *
 * @param {'keepalive'|'search'} role
 * @param {{ id?: number, env?: NodeJS.ProcessEnv }} [opts]  id = search session id (1-based)
 * @returns {{x:number, y:number}}
 */
function resolveWindowPosition(role, { id = 1, env = process.env } = {}) {
  const base = parseWindowPosition(env.BOT_WINDOW_POSITION) || LEGACY[role] || LEGACY.search;
  const stagger = role === 'search' ? Math.max(0, id - 1) * SEARCH_STAGGER_PX : 0;
  return { x: base.x + stagger, y: base.y };
}

/** `--window-position=x,y` ready to push into Chrome args. */
function windowPositionArg(role, opts) {
  const { x, y } = resolveWindowPosition(role, opts);
  return `--window-position=${x},${y}`;
}

module.exports = { parseWindowPosition, resolveWindowPosition, windowPositionArg, LEGACY, SEARCH_STAGGER_PX };
