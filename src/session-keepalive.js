/**
 * Session keep-alive — uses puppeteer to refresh the ANA award search session.
 *
 * Why this is needed:
 * - The award search session lives on aswbe-i.ana.co.jp
 * - ANA's server expires the session after ~1-2 hours of no activity
 * - Pinging www.ana.co.jp does NOT refresh the aswbe-i session (separate servers)
 * - Chrome extension keep-alive is unreliable (tabs freeze, Chrome can close)
 *
 * This module launches a quick puppeteer session every 15 minutes to navigate
 * through the 0771 redirect to aswbe-i.ana.co.jp, which refreshes the session
 * and captures fresh cookies (including _abck from Akamai).
 */
const { connect } = require('puppeteer-real-browser');
const fs = require('fs');
const path = require('path');

const { isStale, markStale } = require('./session-stale');
const COOKIE_PATH = path.join(__dirname, '..', 'data', 'cookies.json');
const KEEPALIVE_INTERVAL_MS = 15 * 60 * 1000; // Every 15 minutes
const STALE_THRESHOLD_MS = 2 * 60 * 60 * 1000; // Alert if >2 hours without refresh

let keepAliveTimer = null;
let isRefreshing = false;
let lastSuccessTime = null;
let onStaleCallback = null;

/**
 * Launch puppeteer, load cookies, navigate to 0771 → aswbe-i, save fresh cookies.
 */
async function refreshSession() {
  if (isRefreshing) {
    console.log('[KeepAlive] Refresh already in progress, skipping');
    return;
  }
  if (isStale()) {
    console.log('[KeepAlive] Session is stale — waiting for fresh cookies from Chrome. Not retrying.');
    return;
  }
  isRefreshing = true;

  let browser = null;
  try {
    // Check if cookies exist
    if (!fs.existsSync(COOKIE_PATH)) {
      console.log('[KeepAlive] No cookies file — skipping');
      return;
    }

    const cookies = JSON.parse(fs.readFileSync(COOKIE_PATH, 'utf8'));
    if (!cookies.some(c => c.name === 'personal')) {
      console.log('[KeepAlive] No personal cookie — need manual login');
      return;
    }

    console.log('[KeepAlive] Launching browser for session refresh...');
    const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    const result = await connect({
      headless: false,
      turnstile: true,
      disableXvfb: true,
      args: ['--start-minimized', '--window-position=-2560,679', '--window-size=800,600'],
      customConfig: {
        chromePath,
        chromiumFlags: ['--disable-backgrounding-occluded-windows'],
      },
    });

    browser = result.browser;
    const page = result.page;

    // Load cookies
    await page.setCookie(...cookies);
    console.log(`[KeepAlive] Loaded ${cookies.length} cookies`);

    // Navigate to 0771 redirect → aswbe-i.ana.co.jp
    await page.goto('https://www.ana.co.jp/other/int/meta/0771.html?CONNECTION_KIND=us&LANG=e', {
      waitUntil: 'networkidle2',
      timeout: 60000,
    });
    await new Promise(r => setTimeout(r, 5000));

    const url = await page.url();
    console.log(`[KeepAlive] Landed on: ${url}`);

    // Check if we reached the search form (session is valid)
    const isOnSearchForm = await page.evaluate(() => {
      const text = document.body.innerText || '';
      return text.includes('Departure') || text.includes('Origin') ||
             text.includes('Award Reservation') || text.includes('出発地');
    });

    if (isOnSearchForm) {
      // Session is alive! Grab fresh cookies and save
      const freshCookies = await page.cookies();
      const puppeteerCookies = freshCookies
        .filter(c => c.domain.includes('ana.co.jp'))
        .map(c => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          secure: c.secure,
          httpOnly: c.httpOnly,
          sameSite: c.sameSite || 'None',
          expires: c.expires > 0 ? c.expires : -1,
        }));

      // Merge with existing cookies (keep ones that puppeteer didn't capture)
      const existingCookies = JSON.parse(fs.readFileSync(COOKIE_PATH, 'utf8'));
      const freshNames = new Set(puppeteerCookies.map(c => `${c.name}|${c.domain}`));
      const merged = [
        ...puppeteerCookies,
        ...existingCookies.filter(c => !freshNames.has(`${c.name}|${c.domain}`)),
      ];

      fs.writeFileSync(COOKIE_PATH, JSON.stringify(merged, null, 2));
      lastSuccessTime = Date.now();
      console.log(`[KeepAlive] ✅ Session alive — saved ${merged.length} cookies`);
    } else {
      // Check if on re-auth login page (AMC pre-filled, only password needed)
      const loginState = await page.evaluate(() => {
        const pwdField = document.querySelector('#password');
        const loginBtn = document.querySelector('#amcMemberLogin');
        const bodyText = document.body?.innerText || '';
        return {
          hasPassword: !!pwdField,
          hasLoginBtn: !!loginBtn,
          isReAuth: bodyText.includes('Logout') || bodyText.includes('TSANGYUNG'),
          isBlocked: bodyText.includes('Your request cannot be accepted'),
          isLoginPage: bodyText.includes('Member Login') || bodyText.includes('AMC number'),
        };
      });

      if (loginState.isBlocked) {
        console.log('[KeepAlive] ⛔ Blocked by Akamai');
        markStale('Blocked by Akamai');
        if (onStaleCallback) onStaleCallback('Blocked by ANA/Akamai — log in to ANA in Chrome. Bot stopped retrying.');
      } else if (loginState.hasPassword || loginState.isLoginPage) {
        // Re-auth page — ANA recognizes us but wants password confirmation
        console.log('[KeepAlive] Re-auth required — entering password...');

        const password = process.env.ANA_PASSWORD;
        if (!password) {
          console.log('[KeepAlive] No ANA_PASSWORD in .env');
          if (onStaleCallback) onStaleCallback('Re-auth needed but no password configured');
          return;
        }

        // Dismiss cookie consent if present
        await page.evaluate(() => {
          const btn = document.querySelector('#ensSave');
          if (btn) btn.click();
        });
        await new Promise(r => setTimeout(r, 1000));

        // Just enter password (AMC number is already pre-filled)
        const pwdField = await page.$('#password');
        if (pwdField) {
          await pwdField.click();
          await pwdField.type(password, { delay: 80 });
          await new Promise(r => setTimeout(r, 1000));

          // Click Login
          const loginBtn = await page.$('#amcMemberLogin');
          if (loginBtn) {
            await loginBtn.click();
            console.log('[KeepAlive] Submitted re-auth...');

            await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
            await new Promise(r => setTimeout(r, 5000));

            // Check if we reached the search form
            const reAuthSuccess = await page.evaluate(() => {
              const text = document.body.innerText || '';
              return text.includes('Departure') || text.includes('Origin') ||
                     text.includes('Award Reservation') || text.includes('出発地');
            });

            if (reAuthSuccess) {
              // Save fresh cookies
              const freshCookies = await page.cookies();
              const puppeteerCookies = freshCookies
                .filter(c => c.domain.includes('ana.co.jp'))
                .map(c => ({
                  name: c.name, value: c.value, domain: c.domain, path: c.path,
                  secure: c.secure, httpOnly: c.httpOnly,
                  sameSite: c.sameSite || 'None',
                  expires: c.expires > 0 ? c.expires : -1,
                }));

              const existingCookies = JSON.parse(fs.readFileSync(COOKIE_PATH, 'utf8'));
              const freshNames = new Set(puppeteerCookies.map(c => `${c.name}|${c.domain}`));
              const merged = [
                ...puppeteerCookies,
                ...existingCookies.filter(c => !freshNames.has(`${c.name}|${c.domain}`)),
              ];

              fs.writeFileSync(COOKIE_PATH, JSON.stringify(merged, null, 2));
              lastSuccessTime = Date.now();
              console.log(`[KeepAlive] ✅ Re-auth successful — saved ${merged.length} cookies`);
            } else {
              console.log('[KeepAlive] ❌ Re-auth failed (Akamai blocked it)');
              markStale('Re-auth failed — Akamai blocked login');
              await page.screenshot({ path: path.join(__dirname, '..', 'data', 'keepalive-reauth-fail.png'), fullPage: true }).catch(() => {});
              if (onStaleCallback) onStaleCallback('Re-auth failed — log in to ANA in Chrome. Bot will stop retrying until you do.');
            }
          }
        }
      } else {
        console.log('[KeepAlive] ❓ Unknown page state');
        await page.screenshot({ path: path.join(__dirname, '..', 'data', 'keepalive-debug.png'), fullPage: true }).catch(() => {});
      }
    }
  } catch (e) {
    console.log(`[KeepAlive] Error: ${e.message}`);
  } finally {
    isRefreshing = false;
    if (browser) {
      try { await browser.close(); } catch {}
    }
    // Clean up orphaned chrome from puppeteer
    try {
      const { execSync } = require('child_process');
      execSync(
        'powershell -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'chrome.exe\'\\" | Where-Object { $_.CommandLine -match \'puppeteer\' } | Select-Object -ExpandProperty ProcessId | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }"',
        { timeout: 10000, windowsHide: true, stdio: 'ignore' }
      );
    } catch {}
  }
}

/**
 * Start the keep-alive loop.
 * @param {Function} staleCallback — called when session is stale/expired
 */
function startKeepAlive(staleCallback) {
  onStaleCallback = staleCallback;

  // First refresh after 1 minute (let the bot settle)
  setTimeout(() => {
    refreshSession();

    // Then every 15 minutes
    keepAliveTimer = setInterval(refreshSession, KEEPALIVE_INTERVAL_MS);
    console.log(`[KeepAlive] Scheduled — refreshing every ${KEEPALIVE_INTERVAL_MS / 60000} min`);
  }, 60000);

  console.log('[KeepAlive] Starting (first refresh in 60s)...');
}

function stopKeepAlive() {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

module.exports = { startKeepAlive, stopKeepAlive, refreshSession };
