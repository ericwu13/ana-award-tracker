/**
 * Background service worker.
 * Handles cookie export requests from the content script and popup.
 * Also tries periodic export via chrome.alarms (unreliable in MV3, content script is primary).
 */

const LOCAL_PORT = 9444;
const ALARM_INTERVAL_MINUTES = 10;

async function gatherAndPushCookies() {
  try {
    const cookies1 = await chrome.cookies.getAll({ domain: 'ana.co.jp' });
    const cookies2 = await chrome.cookies.getAll({ domain: 'aswbe-i.ana.co.jp' });
    const cookies3 = await chrome.cookies.getAll({ domain: 'aswbe-d.ana.co.jp' });

    const seen = new Set();
    const all = [];
    for (const c of [...cookies1, ...cookies2, ...cookies3]) {
      const key = `${c.name}|${c.domain}`;
      if (seen.has(key)) continue;
      seen.add(key);
      all.push({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        sameSite: c.sameSite === 'unspecified' ? 'None' :
                  c.sameSite.charAt(0).toUpperCase() + c.sameSite.slice(1),
        expires: c.expirationDate ? Math.floor(c.expirationDate) : -1,
      });
    }

    if (all.length === 0) return { ok: false, count: 0, error: 'No ANA cookies found' };

    const response = await fetch(`http://127.0.0.1:${LOCAL_PORT}/cookies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(all),
    });

    if (response.ok) {
      console.log(`[Cookie Exporter] Pushed ${all.length} cookies to bot`);
      return { ok: true, count: all.length };
    }
    return { ok: false, count: all.length, error: `HTTP ${response.status}` };
  } catch (e) {
    return { ok: false, count: 0, error: e.message };
  }
}

// Handle messages from content script and popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'exportCookies') {
    gatherAndPushCookies().then(sendResponse);
    return true; // async response
  }
});

// Alarm-based backup (fires even without ANA tab open)
chrome.alarms.create('exportCookies', { periodInMinutes: ALARM_INTERVAL_MINUTES });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'exportCookies') {
    gatherAndPushCookies();
  }
});

// Push on extension install/update
chrome.runtime.onInstalled.addListener(() => {
  gatherAndPushCookies();
});
