/**
 * Import ANA session cookies from your Chrome browser.
 *
 * How it works:
 * 1. Launches YOUR Chrome with a debug port (not puppeteer's Chrome)
 * 2. You log in to ANA manually — no automation, no bot detection
 * 3. You press Enter here, and the script grabs all cookies via CDP
 * 4. Saves them for the bot to use
 *
 * Usage: node import-session.js
 * (Close Chrome first!)
 */
require('dotenv').config();
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const http = require('http');

const CHROME_PATH = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CHROME_PROFILE_DIR = process.env.CHROME_PROFILE_DIR ||
  path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data');
const CHROME_PROFILE = process.env.CHROME_PROFILE || 'Default';
const COOKIE_OUTPUT = path.join(__dirname, 'data', 'cookies.json');
const DEBUG_PORT = 9222;

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans); }));
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

function cdpSend(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9);
    const timeout = setTimeout(() => reject(new Error('CDP timeout')), 10000);

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
  console.log('=== ANA Session Importer ===\n');

  // Launch Chrome with debug port
  console.log(`Launching Chrome with debug port ${DEBUG_PORT}...`);
  const chromeArgs = [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${CHROME_PROFILE_DIR}`,
    `--profile-directory=${CHROME_PROFILE}`,
    'https://www.ana.co.jp/other/int/meta/0771.html?CONNECTION_KIND=us&LANG=e',
  ];

  const chrome = spawn(CHROME_PATH, chromeArgs, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  chrome.unref();

  // Wait for Chrome to start
  console.log('Waiting for Chrome to start...');
  await new Promise(r => setTimeout(r, 3000));

  console.log('\n--------------------------------------------');
  console.log('  Chrome should now be open.');
  console.log('  1. Log in to ANA with your AMC credentials');
  console.log('  2. Make sure you reach the award search form');
  console.log('  3. Come back here and press Enter');
  console.log('--------------------------------------------\n');

  await ask('Press Enter when you are logged in and on the search form...');

  // Connect to Chrome via CDP and grab cookies
  console.log('\nGrabbing cookies from Chrome...');

  let targets;
  try {
    targets = await httpGet(`http://127.0.0.1:${DEBUG_PORT}/json`);
  } catch (e) {
    console.error('Could not connect to Chrome debug port. Is Chrome running?');
    process.exit(1);
  }

  // Find a page target
  const pageTarget = targets.find(t => t.type === 'page' && t.url.includes('ana.co.jp'))
    || targets.find(t => t.type === 'page');

  if (!pageTarget) {
    console.error('No Chrome page found');
    process.exit(1);
  }

  console.log(`Connected to: ${pageTarget.url}`);

  // Use WebSocket to send CDP commands
  const WebSocket = require('ws');
  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });

  // Get ALL cookies (including httpOnly)
  const { cookies } = await cdpSend(ws, 'Network.getAllCookies');
  ws.close();

  // Filter to ANA-related cookies
  const anaCookies = cookies.filter(c =>
    c.domain.includes('ana.co.jp')
  );

  console.log(`Got ${cookies.length} total cookies, ${anaCookies.length} ANA cookies`);

  // Convert to Puppeteer format
  const puppeteerCookies = anaCookies.map(c => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite: c.sameSite || 'None',
    expires: c.expires > 0 ? c.expires : -1,
  }));

  // Save
  fs.mkdirSync(path.dirname(COOKIE_OUTPUT), { recursive: true });
  fs.writeFileSync(COOKIE_OUTPUT, JSON.stringify(puppeteerCookies, null, 2));

  // Check for key cookies
  const hasJsession = puppeteerCookies.some(c => c.name === 'JSESSIONID');
  const hasAbck = puppeteerCookies.some(c => c.name === '_abck');
  const hasPersonal = puppeteerCookies.some(c => c.name === 'personal');

  console.log(`\n✅ Saved ${puppeteerCookies.length} cookies to ${COOKIE_OUTPUT}`);
  console.log(`Session: JSESSIONID=${hasJsession}, _abck=${hasAbck}, personal=${hasPersonal}`);

  if (hasPersonal) {
    console.log('\n🎉 Looks good! The bot should be able to use these cookies.');
    console.log('You can close Chrome now and run: node start.js');
  } else {
    console.log('\n⚠️  Missing "personal" cookie — make sure you are fully logged in on ANA.');
  }

  process.exit(0);
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
