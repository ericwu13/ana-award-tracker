/**
 * Content script — runs on all *.ana.co.jp pages.
 *
 * Two jobs:
 * 1. Push cookies to the bot every 5 minutes
 * 2. Keep the ANA session alive by periodically making requests to ANA
 *    (without this, ANA expires the session server-side even if the tab is open)
 */

const PUSH_INTERVAL_MS = 5 * 60 * 1000;       // Push cookies every 5 min
const KEEPALIVE_INTERVAL_MS = 15 * 60 * 1000;  // Ping ANA every 15 min to keep session alive

function pushCookies() {
  try {
    chrome.runtime.sendMessage({ action: 'exportCookies' }, (response) => {
      if (chrome.runtime.lastError) {
        console.log('[ANA Cookies] Background worker unavailable:', chrome.runtime.lastError.message);
        return;
      }
      if (response?.ok) {
        console.log('[ANA Cookies] Pushed', response.count, 'cookies to bot');
      } else {
        console.log('[ANA Cookies] Push failed:', response?.error || 'bot not running');
      }
    });
  } catch (e) {
    console.log('[ANA Cookies] Push error:', e.message);
  }
}

/**
 * Keep the ANA session alive by making a lightweight request.
 * This prevents server-side session expiry even when the user isn't
 * actively using the ANA tab.
 */
async function keepAlive() {
  try {
    // Lightweight fetch to ANA — just enough to refresh the session cookie
    const resp = await fetch('https://www.ana.co.jp/en/us/', {
      credentials: 'include',
      cache: 'no-store',
    });
    console.log('[ANA Cookies] Session keep-alive ping:', resp.status);

    // After keep-alive, push refreshed cookies
    pushCookies();
  } catch (e) {
    console.log('[ANA Cookies] Keep-alive failed:', e.message);
  }
}

// Push immediately when page loads
pushCookies();

// Push every 5 minutes
setInterval(pushCookies, PUSH_INTERVAL_MS);

// Keep session alive every 15 minutes
setInterval(keepAlive, KEEPALIVE_INTERVAL_MS);

// Push when tab becomes visible (user switches back)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    pushCookies();
  }
});
