/**
 * Independent browser session for parallel ANA searches.
 * Each session has its own browser instance, page, cookies, and session URL.
 */
const { connect } = require('puppeteer-real-browser');
const fs = require('fs');
const path = require('path');
const { parseResults, parseFlightDetails, getPageDebugInfo } = require('./parser');

const COOKIE_PATH = path.join(__dirname, '..', 'data', 'cookies.json');

function randomDelay(minMs = 2000, maxMs = 5000) {
  const ms = Math.floor(Math.random() * (maxMs - minMs)) + minMs;
  return new Promise(r => setTimeout(r, ms));
}

async function isRateLimited(page) {
  return page.evaluate(() => {
    const text = document.body?.innerText || '';
    const hasBlockMessage =
      text.includes('Your request cannot be accepted at this time') ||
      text.includes('ただいま大変混み合っているか、コンピュータの調整中です');
    if (!hasBlockMessage) return false;
    const inputCount = document.querySelectorAll('input, select, textarea').length;
    const hasSearchForm = !!document.querySelector('#departureAirportCode\\:field_pctext, #accountNumber, form[action*="award"]');
    return inputCount === 0 && !hasSearchForm;
  });
}

class Session {
  constructor(id) {
    this.id = id;
    this.tag = `[S${id}]`;
    this.browser = null;
    this.page = null;
    this.sessionBaseUrl = null;
    this.sessionParams = null;
  }

  log(msg) { console.log(`${this.tag} ${msg}`); }

  async launch() {
    const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    const args = [
      '--start-minimized',
      `--window-position=${-1920 + this.id * 320},679`,
      '--window-size=1280,900',
    ];

    this.log('Launching browser...');
    const { browser, page } = await connect({
      headless: false,
      turnstile: true,
      disableXvfb: true,
      args,
      customConfig: {
        chromePath,
        chromiumFlags: ['--disable-backgrounding-occluded-windows'],
      },
    });

    browser.on('disconnected', () => {
      this.log('Browser disconnected');
      this.browser = null;
      this.page = null;
    });

    this.browser = browser;
    this.page = page;

    // Load cookies
    try {
      if (fs.existsSync(COOKIE_PATH)) {
        const cookies = JSON.parse(fs.readFileSync(COOKIE_PATH, 'utf8'));
        if (cookies.length > 0) {
          await page.setCookie(...cookies);
          this.log(`Loaded ${cookies.length} cookies`);
        }
      }
    } catch (e) {
      this.log(`Cookie load error: ${e.message}`);
    }
  }

  async close() {
    this.log('Closing browser...');
    if (this.browser) {
      try { await this.browser.close(); } catch (e) {}
      this.browser = null;
      this.page = null;
    }
  }

  async navigateToSearchForm() {
    const page = this.page;

    this.log('Navigating to search form via 0771 redirect...');
    await page.goto('https://www.ana.co.jp/other/int/meta/0771.html?CONNECTION_KIND=us&LANG=e', {
      waitUntil: 'networkidle2', timeout: 60000,
    });
    await randomDelay(3000, 5000);

    const url = await page.url();
    this.log(`Landed on: ${url}`);

    const isOnSearchForm = await page.evaluate(() => {
      const text = document.body.innerText || '';
      return text.includes('Departure') || text.includes('Origin') ||
             text.includes('Award Reservation') || text.includes('出発地') ||
             text.includes('フライト検索');
    });

    if (isOnSearchForm) {
      this.log('✅ On award search form (cookies worked!)');
      this._saveSessionUrl(url);
      return true;
    }

    if (await isRateLimited(page)) {
      this.log('⛔ Blocked by ANA/Akamai — cookies may have expired');
      const err = new Error('RATE_LIMITED');
      err.rateLimited = true;
      throw err;
    }

    this.log('⚠️ Not on search form — attempting credential login...');
    return this._loginWithCredentials();
  }

  async _loginWithCredentials() {
    const page = this.page;
    const username = process.env.ANA_USERNAME;
    const password = process.env.ANA_PASSWORD;

    if (!username || !password) {
      this.log('No ANA credentials in .env — cannot login');
      return false;
    }

    // Check if we're on the login page
    const hasLoginFields = await page.evaluate(() => {
      return !!(document.querySelector('#accountNumber') && document.querySelector('#password'));
    });

    if (!hasLoginFields) {
      // Dismiss cookie consent overlay that may be hiding the fields
      await page.evaluate(() => {
        const btn = document.querySelector('#ensSave');
        if (btn) btn.click();
      });
      await randomDelay(2000, 3000);

      // Check again after dismissing overlay
      const hasFieldsNow = await page.evaluate(() => {
        return !!(document.querySelector('#accountNumber') && document.querySelector('#password'));
      });

      if (!hasFieldsNow) {
        // Navigate via 0771 to get a login page with proper session tokens
        this.log('Navigating to login page via 0771...');
        await page.goto('https://www.ana.co.jp/other/int/meta/0771.html?CONNECTION_KIND=us&LANG=e', {
          waitUntil: 'networkidle2', timeout: 60000,
        });
        await randomDelay(3000, 5000);
        // Dismiss cookie consent again
        await page.evaluate(() => {
          const btn = document.querySelector('#ensSave');
          if (btn) btn.click();
        });
        await randomDelay(1000, 2000);
      }
    }

    // Enter credentials by typing (JS value assignment doesn't trigger ANA's form binding)
    this.log('Entering credentials...');
    const accountField = await page.$('#accountNumber');
    const passField = await page.$('#password');
    if (!accountField || !passField) {
      this.log('Login fields not found on page');
      return false;
    }

    // Clear and type username
    await accountField.click({ clickCount: 3 });
    await accountField.type(username, { delay: 50 });
    await randomDelay(500, 1000);

    // Clear and type password
    await passField.click({ clickCount: 3 });
    await passField.type(password, { delay: 50 });
    await randomDelay(500, 1000);

    // Click login button
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, input[type="submit"]'));
      const loginBtn = btns.find(b => /log.*in|sign.*in|ログイン/i.test(b.textContent || b.value || ''));
      if (loginBtn) loginBtn.click();
    });

    // Wait for redirect chain to complete
    this.log('Waiting for login redirect...');
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
    await randomDelay(3000, 5000);

    // Check for rate limiting after login
    if (await isRateLimited(page)) {
      this.log('⛔ Rate-limited after login attempt');
      const err = new Error('RATE_LIMITED');
      err.rateLimited = true;
      throw err;
    }

    // Wait for search form (may take multiple redirects)
    for (let i = 0; i < 5; i++) {
      const url = await page.url();
      const hasForm = await page.evaluate(() => {
        return !!(document.querySelector('#departureAirportCode\\:field_pctext'));
      });
      if (hasForm) {
        this.log('✅ Login successful — on search form');
        this._saveSessionUrl(url);
        // Save fresh cookies for next time
        this._saveCookies();
        return true;
      }
      if (!url.includes('login')) break;
      this.log(`Still redirecting... (attempt ${i + 1})`);
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {});
      await randomDelay(1000, 2000);
    }

    // Final check
    const finalUrl = await page.url();
    const hasForm = await page.evaluate(() => {
      return !!(document.querySelector('#departureAirportCode\\:field_pctext'));
    });
    if (hasForm) {
      this.log('✅ Login successful — on search form');
      this._saveSessionUrl(finalUrl);
      this._saveCookies();
      return true;
    }

    this.log('❌ Login failed — could not reach search form');
    await page.screenshot({ path: path.join(__dirname, '..', 'data', 'login-failed.png'), fullPage: true }).catch(() => {});
    return false;
  }

  async _saveCookies() {
    try {
      const cookies = await this.page.cookies();
      fs.writeFileSync(COOKIE_PATH, JSON.stringify(cookies, null, 2));
      this.log(`Saved ${cookies.length} fresh cookies`);
    } catch (e) {
      this.log(`Failed to save cookies: ${e.message}`);
    }
  }

  _saveSessionUrl(url) {
    try {
      if (url.includes('aswbe-i.ana.co.jp')) {
        const urlObj = new URL(url);
        this.sessionBaseUrl = `${urlObj.origin}${urlObj.pathname}`;
        this.sessionParams = urlObj.search;
      }
    } catch (e) {}
  }

  async searchDate({ from, to, date, cabinCode, cabinName }) {
    const page = this.page;
    this.log(`Searching ${from}→${to} ${cabinName} on ${date}`);

    // Navigate to search form if needed
    const alreadyOnForm = await page.evaluate(() => {
      return !!document.querySelector('#departureAirportCode\\:field_pctext');
    });

    if (!alreadyOnForm) {
      if (this.sessionBaseUrl) {
        await page.goto(this.sessionBaseUrl + (this.sessionParams || ''), {
          waitUntil: 'networkidle2', timeout: 60000,
        });
      } else {
        await page.goto('https://www.ana.co.jp/other/int/meta/0771.html?CONNECTION_KIND=us&LANG=e', {
          waitUntil: 'networkidle2', timeout: 60000,
        });
      }
      await randomDelay(3000, 5000);
    }

    if (await isRateLimited(page)) {
      const err = new Error('RATE_LIMITED');
      err.rateLimited = true;
      throw err;
    }

    // Check if redirected to login
    const needsLogin = await page.evaluate(() => {
      return window.location.href.includes('login') || window.location.href.includes('Login');
    });
    if (needsLogin) {
      this.log('Session expired');
      return { results: [], needsLogin: true };
    }

    // Switch to one-way
    const owEl = await page.$('[id*="oneway"], [id*="oneWay"], input[value="oneway"]');
    if (owEl) {
      await owEl.click();
      await randomDelay(3000, 5000);
      await page.waitForFunction(() => document.readyState === 'complete', { timeout: 10000 }).catch(() => {});
      await randomDelay(1000, 2000);
    }

    // Select cabin class
    await page.select('#boardingClass', cabinCode).catch(() => {});
    await page.evaluate((code) => {
      const sel = document.querySelector('#boardingClass');
      if (sel) { sel.value = code; sel.dispatchEvent(new Event('change', { bubbles: true })); }
    }, cabinCode);
    await randomDelay(1000, 2000);

    // Fill departure
    const [year, month, day] = date.split('-');
    const depTextSel = '#departureAirportCode\\:field_pctext';
    await page.click(depTextSel).catch(() => {});
    await randomDelay(300, 500);
    await page.evaluate((sel) => { document.querySelector(sel).value = ''; }, depTextSel);
    await page.type(depTextSel, from, { delay: 150 });
    await randomDelay(2000, 3000);
    await page.keyboard.press('ArrowDown');
    await randomDelay(300, 500);
    await page.keyboard.press('Enter');
    await randomDelay(1500, 2000);

    // Fill arrival
    const arrTextSel = '#arrivalAirportCode\\:field_pctext';
    await page.click(arrTextSel).catch(() => {});
    await randomDelay(300, 500);
    await page.evaluate((sel) => { document.querySelector(sel).value = ''; }, arrTextSel);
    await page.type(arrTextSel, to, { delay: 150 });
    await randomDelay(2000, 3000);
    await page.keyboard.press('ArrowDown');
    await randomDelay(300, 500);
    await page.keyboard.press('Enter');
    await randomDelay(1500, 2000);

    // Set date — directly set hidden field (calendar is unreliable)
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const dateObj = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
    const dayOfWeek = dayNames[dateObj.getDay()];
    const visibleDate = `${month}/${day}/${year} (${dayOfWeek})`;
    const hiddenDate = `${year}${month}${day}`;

    // Try calendar first (click to open, then close it)
    const dateTextSel = '#awardDepartureDate\\:field_pctext';
    await page.click(dateTextSel).catch(() => {});
    await randomDelay(1500, 2500);

    // Close calendar modal if open
    await page.evaluate(() => {
      const mask = document.querySelector('#maskForClose');
      if (mask && mask.offsetParent !== null) mask.click();
      const closeBtn = document.querySelector('.modalCloseButton a, .modalCloseButton button');
      if (closeBtn) closeBtn.click();
    });
    await randomDelay(500, 1000);

    // Force-set date fields
    await page.evaluate((hDate, vDate) => {
      const dt = document.querySelector('[id="awardDepartureDate:field"]');
      const dtText = document.querySelector('[id="awardDepartureDate:field_pctext"]');
      if (dt) { dt.value = hDate; dt.dispatchEvent(new Event('change', { bubbles: true })); }
      if (dtText) { dtText.value = vDate; }
      // Enable "Compare seat availability ±3 days" checkbox
      const cb = document.querySelector('#comparisonSearchType');
      if (cb && !cb.checked) cb.click();
    }, hiddenDate, visibleDate);
    await randomDelay(1000, 1500);

    // Submit search
    const submitClicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('input[type="submit"]'));
      let btn = btns.find(b => b.value === 'Search' || b.value === '検索する');
      if (!btn) btn = btns.find(b => b.className.includes('btnWidthVariable'));
      if (btn) { btn.scrollIntoView({ behavior: 'instant', block: 'center' }); return true; }
      return false;
    });

    if (submitClicked) {
      await randomDelay(500, 1000);
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('input[type="submit"]'));
        let btn = btns.find(b => b.value === 'Search' || b.value === '検索する');
        if (!btn) btn = btns.find(b => b.className.includes('btnWidthVariable'));
        if (btn) btn.click();
      });
    }

    // Wait for results
    await randomDelay(3000, 5000);
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
    await randomDelay(2000, 4000);

    if (await isRateLimited(page)) {
      const err = new Error('RATE_LIMITED');
      err.rateLimited = true;
      throw err;
    }

    // Check if we're on the calendar comparison page
    const isCalendarPage = await page.evaluate(() => {
      const url = window.location.href;
      const text = document.body?.innerText || '';
      return url.includes('calendar') || text.includes('Compare seat availability');
    });

    // Parse calendar results first (which dates have availability)
    const calendarResults = await parseResults(page, cabinName);
    this.log(`Calendar: ${calendarResults.length} result(s) for ${date}`);

    // Click "Next" to get detailed flight info
    if (isCalendarPage) {
      const clicked = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('input[type="submit"]'));
        const next = btns.find(b => /next|次/i.test(b.value));
        if (next) { next.click(); return true; }
        return false;
      });

      if (clicked) {
        await randomDelay(3000, 5000);
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
        await randomDelay(2000, 3000);

        // Parse the flight detail page
        const detailResults = await parseFlightDetails(page, cabinName);
        if (detailResults.length > 0) {
          this.log(`Flights: ${detailResults.length} itinerary(s) for ${date}`);
          return { results: detailResults, needsLogin: false };
        }
      }
    }

    // Fallback to calendar results if detail page didn't work
    return { results: calendarResults, needsLogin: false };
  }
}

/**
 * Run search jobs across multiple parallel sessions.
 * @param {Array} jobs - Array of { from, to, dates, cabinCode, cabinName }
 * @param {number} maxSessions - Max concurrent browser sessions
 * @returns {Array} All results: [{ route, cabin, date, results }]
 */
async function runParallel(jobs, maxSessions = 4) {
  const allResults = [];
  const sessions = [];

  // Flatten jobs into individual search tasks
  const tasks = [];
  for (const job of jobs) {
    for (const date of job.dates) {
      tasks.push({ from: job.from, to: job.to, date, cabinCode: job.cabinCode, cabinName: job.cabinName });
    }
  }

  console.log(`[Parallel] ${tasks.length} search tasks across ${Math.min(maxSessions, tasks.length)} sessions`);

  // Split tasks into chunks for each session
  const numSessions = Math.min(maxSessions, tasks.length);
  const chunks = Array.from({ length: numSessions }, () => []);
  tasks.forEach((task, i) => chunks[i % numSessions].push(task));

  // Launch sessions and run in parallel
  const workers = chunks.map(async (chunk, i) => {
    const session = new Session(i + 1);
    sessions.push(session);

    try {
      await session.launch();
      const ok = await session.navigateToSearchForm();
      if (!ok) {
        session.log('Could not reach search form — skipping');
        allResults.push({ _sessionFailed: true, error: 'Cookie expired or login failed', sessionId: i + 1 });
        return;
      }

      for (const task of chunk) {
        try {
          const { results } = await session.searchDate(task);
          allResults.push({
            route: `${task.from}→${task.to}`,
            cabin: task.cabinName,
            date: task.date,
            results,
          });
        } catch (err) {
          session.log(`Error searching ${task.date}: ${err.message}`);
          if (err.rateLimited) throw err; // Stop this session
          allResults.push({ route: `${task.from}→${task.to}`, cabin: task.cabinName, date: task.date, results: [] });
        }

        // Delay between searches
        await randomDelay(2000, 4000);
      }
    } catch (err) {
      session.log(`Session error: ${err.message}`);
      allResults.push({ _sessionFailed: true, error: err.message, rateLimited: err.rateLimited, sessionId: i + 1 });
      if (err.rateLimited) throw err;
    } finally {
      await session.close();
    }
  });

  await Promise.all(workers);
  return allResults;
}

module.exports = { Session, runParallel };
