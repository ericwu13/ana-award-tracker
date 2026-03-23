/**
 * Auto-refresh ANA cookies by briefly restarting Chrome with a debug port.
 * Uses a directory junction to bypass Chrome 146's debug port restriction.
 * Chrome is down for ~10 seconds.
 *
 * Usage: node refresh-cookies.js
 */
require('dotenv').config();
const { execSync, spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CHROME_PATH = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CHROME_PROFILE_DIR = process.env.CHROME_PROFILE_DIR ||
  path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data');
const CHROME_PROFILE = process.env.CHROME_PROFILE || 'Default';
const COOKIE_OUTPUT = path.join(__dirname, 'data', 'cookies.json');
const LINK_PATH = path.join(__dirname, 'data', 'chrome-link');
const DEBUG_PORT = 9222;

function httpGet(url, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), timeout);
    http.get(url, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { clearTimeout(timer); resolve(JSON.parse(data)); });
    }).on('error', e => { clearTimeout(timer); reject(e); });
  });
}

function cdpSend(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9);
    const timeout = setTimeout(() => reject(new Error('CDP timeout')), 15000);
    const handler = (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === id) {
        clearTimeout(timeout);
        ws.removeListener('message', handler);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function main() {
  const WebSocket = require('ws');
  console.log('[Cookies] Auto-refreshing ANA cookies...');

  // Step 1: Kill Chrome
  console.log('[Cookies] Stopping Chrome briefly...');
  try {
    execSync('powershell -Command "Stop-Process -Name chrome -Force -ErrorAction SilentlyContinue"', { windowsHide: true });
  } catch {}
  await new Promise(r => setTimeout(r, 3000));

  // Step 2: Create junction symlink (bypasses Chrome 146 debug port restriction)
  try { fs.rmSync(LINK_PATH, { recursive: true, force: true }); } catch {}
  try {
    execSync(`cmd /c "mklink /J "${LINK_PATH}" "${CHROME_PROFILE_DIR}""`, { windowsHide: true, stdio: 'ignore' });
  } catch {}

  // Step 3: Launch Chrome with debug port via the junction
  // Navigate to ana.co.jp so persistent cookies get loaded into memory
  console.log('[Cookies] Launching Chrome with debug port...');
  const chrome = spawn(CHROME_PATH, [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${LINK_PATH}`,
    `--profile-directory=${CHROME_PROFILE}`,
    '--disable-background-mode',
    '--no-first-run',
    '--start-minimized',
    'https://www.ana.co.jp/en/us/',
  ], { detached: true, stdio: 'ignore', windowsHide: false });
  chrome.unref();

  // Step 4: Wait for Chrome and cookies to load
  let cookies = null;
  for (let attempt = 0; attempt < 15; attempt++) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      const targets = await httpGet(`http://127.0.0.1:${DEBUG_PORT}/json`, 3000);
      const page = targets.find(t => t.type === 'page') || targets[0];

      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
        setTimeout(() => reject(new Error('ws timeout')), 5000);
      });

      // Enable network and get all cookies
      await cdpSend(ws, 'Network.enable');
      const result = await cdpSend(ws, 'Network.getAllCookies');
      ws.close();

      const allCookies = result?.cookies || [];
      cookies = allCookies.filter(c => c.domain.includes('ana.co.jp'));

      if (cookies.length > 5) {
        console.log(`[Cookies] Got ${cookies.length} ANA cookies (attempt ${attempt + 1})`);
        break;
      } else {
        console.log(`[Cookies] Only ${cookies.length} ANA cookies so far, waiting...`);
        cookies = null;
      }
    } catch (e) {
      if (attempt < 14) {
        console.log(`[Cookies] Attempt ${attempt + 1}/15: ${e.message}`);
      }
    }
  }

  // Step 5: Kill Chrome (it was only needed briefly)
  console.log('[Cookies] Closing Chrome...');
  try {
    execSync('powershell -Command "Stop-Process -Name chrome -Force -ErrorAction SilentlyContinue"', { windowsHide: true });
  } catch {}

  // Clean up junction
  try { fs.rmSync(LINK_PATH, { recursive: true, force: true }); } catch {}

  if (!cookies || cookies.length === 0) {
    console.error('[Cookies] ❌ No ANA cookies found. Log in to ANA in Chrome first.');
    process.exit(1);
  }

  // Step 6: Save
  const out = cookies.map(c => ({
    name: c.name, value: c.value, domain: c.domain, path: c.path,
    secure: c.secure, httpOnly: c.httpOnly,
    sameSite: c.sameSite || 'None',
    expires: c.expires > 0 ? c.expires : -1,
  }));

  fs.writeFileSync(COOKIE_OUTPUT, JSON.stringify(out, null, 2));

  const has = (n) => out.some(c => c.name === n);
  console.log(`[Cookies] ✅ Saved ${out.length} cookies to ${COOKIE_OUTPUT}`);
  console.log(`[Cookies] personal: ${has('personal')} | _abck: ${has('_abck')}`);

  if (!has('personal')) {
    console.log('[Cookies] ⚠️ No "personal" cookie — you may need to log in to ANA in Chrome.');
  } else {
    console.log('[Cookies] 🎉 Cookies refreshed successfully!');
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); });
