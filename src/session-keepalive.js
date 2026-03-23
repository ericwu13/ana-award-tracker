/**
 * Session keep-alive — periodically pings ANA from Node.js to prevent
 * server-side session expiry. Runs inside the persistent Discord bot process.
 *
 * This replaces the unreliable Chrome extension approach:
 * - Chrome can close/crash
 * - Background tabs get frozen (timers stop)
 * - MV3 service workers die after 30s
 *
 * The Discord bot is always running, so this is reliable.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const COOKIE_PATH = path.join(__dirname, '..', 'data', 'cookies.json');
const KEEPALIVE_INTERVAL_MS = 10 * 60 * 1000; // Every 10 minutes
const STALE_THRESHOLD_MS = 60 * 60 * 1000;    // Alert if cookies older than 1 hour

let keepAliveTimer = null;
let lastSuccessTime = null;
let onStaleCallback = null;

/**
 * Read cookies from disk and format as a Cookie header string.
 */
function getCookieHeader(domain) {
  try {
    const cookies = JSON.parse(fs.readFileSync(COOKIE_PATH, 'utf8'));
    return cookies
      .filter(c => domain.endsWith(c.domain.replace(/^\./, '')) || c.domain === domain)
      .map(c => `${c.name}=${c.value}`)
      .join('; ');
  } catch {
    return '';
  }
}

/**
 * Make an HTTP request to ANA with cookies to keep the session alive.
 */
function pingANA() {
  const cookieHeader = getCookieHeader('ana.co.jp');
  if (!cookieHeader || cookieHeader.length < 50) {
    console.log('[KeepAlive] No cookies to send — skipping');
    return;
  }

  // Ping www.ana.co.jp — lightweight request with the personal cookie
  const options = {
    hostname: 'www.ana.co.jp',
    path: '/en/us/',
    method: 'GET',
    headers: {
      'Cookie': cookieHeader,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
      'Accept': 'text/html',
    },
    timeout: 15000,
  };

  const req = https.request(options, (res) => {
    // Consume the response (don't need the body)
    res.resume();

    if (res.statusCode === 200 || res.statusCode === 302) {
      lastSuccessTime = Date.now();
      console.log(`[KeepAlive] ANA ping OK (${res.statusCode})`);

      // Check for Set-Cookie headers — ANA may refresh cookies
      const setCookies = res.headers['set-cookie'];
      if (setCookies && setCookies.length > 0) {
        console.log(`[KeepAlive] ${setCookies.length} cookies refreshed by ANA`);
        // Update cookies in file with new values
        updateCookiesFromResponse(setCookies);
      }
    } else {
      console.log(`[KeepAlive] ANA ping returned ${res.statusCode}`);
    }
  });

  req.on('error', (e) => {
    console.log(`[KeepAlive] ANA ping failed: ${e.message}`);
  });

  req.on('timeout', () => {
    console.log('[KeepAlive] ANA ping timed out');
    req.destroy();
  });

  req.end();
}

/**
 * Update stored cookies with Set-Cookie values from ANA's response.
 */
function updateCookiesFromResponse(setCookieHeaders) {
  try {
    const cookies = JSON.parse(fs.readFileSync(COOKIE_PATH, 'utf8'));
    let updated = 0;

    for (const header of setCookieHeaders) {
      const parts = header.split(';')[0]; // "name=value"
      const eqIdx = parts.indexOf('=');
      if (eqIdx === -1) continue;
      const name = parts.substring(0, eqIdx).trim();
      const value = parts.substring(eqIdx + 1).trim();

      const existing = cookies.find(c => c.name === name);
      if (existing && existing.value !== value) {
        existing.value = value;
        updated++;
      }
    }

    if (updated > 0) {
      fs.writeFileSync(COOKIE_PATH, JSON.stringify(cookies, null, 2));
      console.log(`[KeepAlive] Updated ${updated} cookie(s) in file`);
    }
  } catch (e) {
    console.log(`[KeepAlive] Cookie update error: ${e.message}`);
  }
}

/**
 * Check if cookies are stale and alert if needed.
 */
function checkStaleness() {
  try {
    const stat = fs.statSync(COOKIE_PATH);
    const ageMs = Date.now() - stat.mtimeMs;

    if (ageMs > STALE_THRESHOLD_MS && onStaleCallback) {
      const ageMin = Math.round(ageMs / 60000);
      console.log(`[KeepAlive] ⚠️ Cookies are ${ageMin}min old — may be stale`);
      onStaleCallback(ageMin);
    }
  } catch {}
}

/**
 * Start the keep-alive loop.
 * @param {Function} staleCallback — called when cookies are stale, receives age in minutes
 */
function startKeepAlive(staleCallback) {
  onStaleCallback = staleCallback;

  // Ping immediately
  pingANA();

  // Then every 10 minutes
  keepAliveTimer = setInterval(() => {
    pingANA();
    checkStaleness();
  }, KEEPALIVE_INTERVAL_MS);

  console.log(`[KeepAlive] Started — pinging ANA every ${KEEPALIVE_INTERVAL_MS / 60000} min`);
}

function stopKeepAlive() {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

module.exports = { startKeepAlive, stopKeepAlive };
