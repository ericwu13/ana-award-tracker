/**
 * HTTP server that receives cookies from the Chrome extension.
 * Validates key cookies are present and tracks freshness.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.COOKIE_SERVER_PORT || '9444');
const COOKIE_PATH = path.join(__dirname, '..', 'data', 'cookies.json');
const { clearStale } = require('./session-stale');
const KEY_COOKIES = ['personal', '_abck']; // Must be present for a valid session

let server = null;
let lastPushTime = null;

function startCookieServer() {
  if (server) return;

  server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Health check — reports cookie freshness
    if (req.method === 'GET' && req.url === '/health') {
      const age = lastPushTime ? Math.round((Date.now() - lastPushTime) / 1000) : null;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, lastPushAge: age }));
      return;
    }

    if (req.method === 'POST' && req.url === '/cookies') {
      let body = '';
      req.on('data', chunk => {
        body += chunk;
        if (body.length > 1_000_000) { res.writeHead(413); res.end('Too large'); req.destroy(); }
      });
      req.on('end', () => {
        try {
          const cookies = JSON.parse(body);
          if (!Array.isArray(cookies) || cookies.length === 0) {
            res.writeHead(400);
            res.end('Invalid cookies');
            return;
          }

          // Validate key cookies are present in the incoming push
          const missing = KEY_COOKIES.filter(name => !cookies.some(c => c.name === name));

          // If the push is missing key cookies, preserve them from the existing
          // file instead of destroying them. The extension can briefly push an
          // incomplete batch (e.g. between Chrome events) and we don't want a
          // single bad push to wipe a working `personal` cookie permanently.
          let finalCookies = cookies;
          let preservedCount = 0;
          if (missing.length > 0) {
            try {
              const existing = JSON.parse(fs.readFileSync(COOKIE_PATH, 'utf8'));
              const preserved = existing.filter(c => missing.includes(c.name));
              if (preserved.length > 0) {
                finalCookies = [...cookies, ...preserved];
                preservedCount = preserved.length;
              }
            } catch {
              // No existing file or unreadable — fall through with what we have
            }
          }

          // Re-evaluate after merge: do we now have all key cookies on disk?
          const finalMissing = KEY_COOKIES.filter(name => !finalCookies.some(c => c.name === name));

          fs.mkdirSync(path.dirname(COOKIE_PATH), { recursive: true });
          fs.writeFileSync(COOKIE_PATH, JSON.stringify(finalCookies, null, 2));
          lastPushTime = Date.now();

          // Clear stale flag only when we have a fully valid set
          if (finalMissing.length === 0) clearStale();

          if (missing.length === 0) {
            console.log(`[CookieServer] Received ${cookies.length} cookies (valid)`);
          } else if (preservedCount > 0) {
            console.log(`[CookieServer] Received ${cookies.length} cookies, push missing ${missing.join(',')} — preserved ${preservedCount} from existing (final missing: ${finalMissing.join(',') || 'none'})`);
          } else {
            console.log(`[CookieServer] Received ${cookies.length} cookies, INCOMPLETE — still missing ${finalMissing.join(',')}`);
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, count: finalCookies.length, missing: finalMissing, preserved: preservedCount }));
        } catch (e) {
          res.writeHead(400);
          res.end(e.message);
        }
      });
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[CookieServer] Listening on http://127.0.0.1:${PORT}`);
  });

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.log('[CookieServer] Port already in use — another instance running');
    } else {
      console.error('[CookieServer] Error:', e.message);
    }
  });
}

function stopCookieServer() {
  if (server) {
    server.close();
    server = null;
  }
}

function getCookieAge() {
  if (!lastPushTime) {
    try {
      const stat = fs.statSync(COOKIE_PATH);
      return Math.round((Date.now() - stat.mtimeMs) / 1000);
    } catch { return null; }
  }
  return Math.round((Date.now() - lastPushTime) / 1000);
}

module.exports = { startCookieServer, stopCookieServer, getCookieAge };
