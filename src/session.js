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
    const title = document.title || '';

    // Match by message content
    const hasBlockMessage =
      text.includes('Your request cannot be accepted at this time') ||
      text.includes('ただいま大変混み合っているか、コンピュータの調整中です') ||
      text.includes('heavy traffic or server maintenance') ||
      text.includes('Please try at a later time');

    // Also match by ANA's "Information" error page title
    const hasErrorTitle = title.includes('ご案内') || title.includes('Information');

    if (!hasBlockMessage && !hasErrorTitle) return false;
    if (!hasBlockMessage) return false; // need message text to confirm

    // The error page has minimal content — no search form, no login form
    const hasSearchForm = !!document.querySelector('#departureAirportCode\\:field_pctext, #accountNumber, form[action*="award"]');
    return !hasSearchForm;
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

    // Force-set date fields — do NOT use calendar comparison (±3 days)
    // Each date gets its own direct search for full flight details
    await page.evaluate((hDate, vDate) => {
      const dt = document.querySelector('[id="awardDepartureDate:field"]');
      const dtText = document.querySelector('[id="awardDepartureDate:field_pctext"]');
      if (dt) { dt.value = hDate; dt.dispatchEvent(new Event('change', { bubbles: true })); }
      if (dtText) { dtText.value = vDate; }
      // UNCHECK comparison — go straight to flight detail page
      const cb = document.querySelector('#comparisonSearchType');
      if (cb && cb.checked) cb.click();
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

    // Check for ANA's 96-hour booking deadline error before parsing
    const unbookable = await page.evaluate(() => {
      const text = document.body?.innerText || '';
      return text.includes('E_A01P01_0008') || text.includes('application deadline has passed');
    });
    if (unbookable) {
      this.log(`Date ${date} unbookable (within 96-hour deadline)`);
      return { results: [{ noResults: true, unbookable: true, reason: '96-hour deadline' }], needsLogin: false };
    }

    // We should be on the flight detail page (not calendar, since we unchecked comparison)
    // Parse flight details directly
    const detailResults = await parseFlightDetails(page, cabinName);
    if (detailResults.length > 0) {
      this.log(`${detailResults.length} flight(s) for ${date}`);
      return { results: detailResults, needsLogin: false };
    }

    // Check if "no results" page
    const noResults = await page.evaluate(() => {
      const text = document.body?.innerText || '';
      return text.includes('no flights') || text.includes('E_A01P01_0006') ||
             text.includes('合うものがありませんでした');
    });
    if (noResults) {
      this.log(`No flights for ${date}`);
      return { results: [{ noResults: true }], needsLogin: false };
    }

    // Fallback: might still be on calendar if checkbox didn't uncheck
    const calendarResults = await parseResults(page, cabinName);
    if (calendarResults.length > 0) {
      this.log(`Calendar fallback: ${calendarResults.length} result(s) for ${date}`);
      return { results: calendarResults, needsLogin: false };
    }

    this.log(`No results parsed for ${date}`);
    return { results: [], needsLogin: false };
  }
}

/**
 * Run search jobs across multiple parallel sessions.
 * @param {Array} jobs - Array of { from, to, dates, cabinCode, cabinName }
 * @param {number} maxSessions - Max concurrent browser sessions
 * @returns {Array} All results: [{ route, cabin, date, results }]
 */
async function runParallel(jobs, maxSessions = 4, lastChecked = {}) {
  const allResults = [];
  const sessions = [];

  // Flatten jobs into individual search tasks
  const tasks = [];
  for (const job of jobs) {
    for (const date of job.dates) {
      tasks.push({ from: job.from, to: job.to, date, cabinCode: job.cabinCode, cabinName: job.cabinName });
    }
  }

  // Prioritize oldest-checked (and never-checked) tasks first to prevent starvation.
  // Without this, the stable date-sort meant later dates (e.g. October) were always
  // at the back of the queue and got skipped whenever sessions hit Akamai throttle.
  // Bucket by lastChecked timestamp (rounded) so ties get shuffled — this also breaks
  // up cabin/route segregation so a single session failure doesn't wipe out one cabin.
  const taskKey = t => `${t.from}→${t.to}|${t.date}|${t.cabinName}`;
  const buckets = new Map();
  for (const t of tasks) {
    const ts = lastChecked[taskKey(t)] || 0;
    if (!buckets.has(ts)) buckets.set(ts, []);
    buckets.get(ts).push(t);
  }
  const sortedTimestamps = [...buckets.keys()].sort((a, b) => a - b);
  const shuffled = [];
  for (const ts of sortedTimestamps) {
    const group = buckets.get(ts);
    // Fisher-Yates shuffle within tied tasks
    for (let i = group.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [group[i], group[j]] = [group[j], group[i]];
    }
    shuffled.push(...group);
  }
  const neverChecked = (buckets.get(0) || []).length;
  console.log(`[Parallel] ${shuffled.length} search tasks across ${Math.min(maxSessions, shuffled.length)} sessions (oldest-checked first, ${neverChecked} never checked)`);

  // Round-robin distribution. With shuffled cabins, each session gets a fair mix.
  const numSessions = Math.min(maxSessions, shuffled.length);
  const chunks = Array.from({ length: numSessions }, () => []);
  shuffled.forEach((task, i) => chunks[i % numSessions].push(task));

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

      let consecutiveRateLimits = 0;
      for (const task of chunk) {
        try {
          const { results } = await session.searchDate(task);
          allResults.push({
            route: `${task.from}→${task.to}`,
            cabin: task.cabinName,
            date: task.date,
            results,
          });
          consecutiveRateLimits = 0; // success — reset counter
        } catch (err) {
          session.log(`Error searching ${task.date}: ${err.message}`);

          if (err.rateLimited) {
            consecutiveRateLimits++;
            // Record this date as failed but continue
            allResults.push({ route: `${task.from}→${task.to}`, cabin: task.cabinName, date: task.date, results: [], _rateLimited: true });

            // After 3 consecutive rate limits, give up on this session
            if (consecutiveRateLimits >= 3) {
              session.log('3 consecutive rate limits — giving up on this session');
              throw err;
            }
            // Back off and try next date
            session.log(`Rate limit ${consecutiveRateLimits}/3 — backing off 30s before next search`);
            await new Promise(r => setTimeout(r, 30000));
            continue;
          }

          // Non-rate-limit error: record empty result and continue
          allResults.push({ route: `${task.from}→${task.to}`, cabin: task.cabinName, date: task.date, results: [] });
        }

        // Delay between searches — be gentle to avoid rate limiting
        await randomDelay(5000, 10000);
      }
    } catch (err) {
      session.log(`Session error: ${err.message}`);
      allResults.push({ _sessionFailed: true, error: err.message, rateLimited: err.rateLimited, sessionId: i + 1 });
      // Don't re-throw — let other sessions continue. allSettled handles the rest.
    } finally {
      await session.close();
    }
  });

  await Promise.allSettled(workers);
  return allResults;
}

module.exports = { Session, runParallel };
