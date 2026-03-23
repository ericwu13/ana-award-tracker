/**
 * Content script — runs on all *.ana.co.jp pages.
 *
 * Two jobs:
 * 1. Push cookies to the bot every 5 minutes
 * 2. Keep the ANA session alive by periodically reloading the page
 *
 * Uses a Web Lock to prevent Chrome from freezing this tab in the background.
 */

const PUSH_INTERVAL_MS = 5 * 60 * 1000;       // Push cookies every 5 min
const KEEPALIVE_INTERVAL_MS = 14 * 60 * 1000;  // Reload page every 14 min to keep session alive

// Prevent Chrome from freezing this tab by holding a Web Lock
// (Chrome won't freeze tabs that hold active locks)
try {
  navigator.locks.request('ana-award-tracker-keepalive', () => {
    // Return a promise that never resolves — holds the lock forever
    return new Promise(() => {});
  });
  console.log('[ANA Cookies] Web Lock acquired — tab will not be frozen');
} catch (e) {
  console.log('[ANA Cookies] Web Lock not available:', e.message);
}

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
        console.log('[ANA Cookies] Push result:', response?.error || 'bot not running');
      }
    });
  } catch (e) {
    console.log('[ANA Cookies] Push error:', e.message);
  }
}

// Push immediately when page loads
pushCookies();

// Push every 5 minutes
setInterval(pushCookies, PUSH_INTERVAL_MS);

// Keep session alive by reloading the page every 14 minutes.
// This makes a REAL browser request to ANA (with full Akamai fingerprint),
// which the server trusts and extends the session timeout.
// Using reload instead of fetch because:
// - Akamai validates browser fingerprint on each request
// - A real page load generates proper sensor data
// - fetch() from a content script may not trigger Akamai properly
setInterval(() => {
  console.log('[ANA Cookies] Reloading page to keep session alive...');
  window.location.reload();
}, KEEPALIVE_INTERVAL_MS);

// Push when tab becomes visible
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    pushCookies();
  }
});
