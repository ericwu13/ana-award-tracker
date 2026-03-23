/**
 * HTTP server that receives cookies from the Chrome extension.
 * Validates key cookies are present and tracks freshness.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.COOKIE_SERVER_PORT || '9444');
const COOKIE_PATH = path.join(__dirname, '..', 'data', 'cookies.json');
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
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const cookies = JSON.parse(body);
          if (!Array.isArray(cookies) || cookies.length === 0) {
            res.writeHead(400);
            res.end('Invalid cookies');
            return;
          }

          // Validate key cookies are present
          const missing = KEY_COOKIES.filter(name => !cookies.some(c => c.name === name));
          if (missing.length > 0) {
            console.log(`[CookieServer] ⚠️ Missing key cookies: ${missing.join(', ')} — session may be expired`);
          }

          fs.mkdirSync(path.dirname(COOKIE_PATH), { recursive: true });
          fs.writeFileSync(COOKIE_PATH, JSON.stringify(cookies, null, 2));
          lastPushTime = Date.now();

          console.log(`[CookieServer] Received ${cookies.length} cookies (${missing.length === 0 ? 'valid' : 'INCOMPLETE'})`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, count: cookies.length, missing }));
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
