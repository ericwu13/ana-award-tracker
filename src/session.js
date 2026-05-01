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
      connectOption: {
        // Cap CDP at 90s so wedged renderers fail fast and the outer loop can recover.
        // Healthy searchDate() calls finish well under 60s; 90s gives headroom for occasional Akamai sensor stalls.
        protocolTimeout: 90000,
      },
    });

    browser.on('disconnected', () => {
      this.log('Browser disconnected');
      this.browser = null;
      this.page = null;
    });

    this.browser = browser;
    this.page = page;

    // Track virtual mouse position so _moveTo can draw a continuous bezier path
    // from one element to the next instead of teleporting. Akamai's behavioural
    // signal looks at cursor trajectories, so jumping around is a flag.
    this._mouseX = 100 + Math.floor(Math.random() * 1080);
    this._mouseY = 100 + Math.floor(Math.random() * 700);

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

    // ANA serves two login variants depending on session state:
    //   FULL login   — page has #accountNumber AND #password (both must be filled)
    //   RE-AUTH page — only #password is shown; AMC number is pre-filled and masked
    //                  ("Logout TSANGYUNG WU AMC number ******3695 Password"), with
    //                  the #amcMemberLogin submit button. Triggered after idle.
    // We need to handle both. Detect by checking which input fields exist.

    const detectLoginForm = () => page.evaluate(() => ({
      hasAccount: !!document.querySelector('#accountNumber'),
      hasPassword: !!document.querySelector('#password'),
    }));

    let form = await detectLoginForm();

    if (!form.hasPassword) {
      // Dismiss cookie consent overlay that may be hiding the fields
      await page.evaluate(() => {
        const btn = document.querySelector('#ensSave');
        if (btn) btn.click();
      });
      await randomDelay(2000, 3000);
      form = await detectLoginForm();

      if (!form.hasPassword) {
        // Navigate via 0771 to get a fresh login page with proper session tokens
        this.log('Navigating to login page via 0771...');
        await page.goto('https://www.ana.co.jp/other/int/meta/0771.html?CONNECTION_KIND=us&LANG=e', {
          waitUntil: 'networkidle2', timeout: 60000,
        });
        await randomDelay(3000, 5000);
        await page.evaluate(() => {
          const btn = document.querySelector('#ensSave');
          if (btn) btn.click();
        });
        await randomDelay(1000, 2000);
        form = await detectLoginForm();
      }
    }

    if (!form.hasPassword) {
      this.log('Password field not found on page — cannot login');
      return false;
    }

    const passField = await page.$('#password');

    if (form.hasAccount) {
      // Full login: type both AMC number and password
      this.log('Entering credentials (full login)...');
      const accountField = await page.$('#accountNumber');
      await accountField.click({ clickCount: 3 });
      await accountField.type(username, { delay: 50 });
      await randomDelay(500, 1000);

      await passField.click({ clickCount: 3 });
      await passField.type(password, { delay: 50 });
      await randomDelay(500, 1000);

      // Click login button by text match (works for the full-login layout)
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, input[type="submit"]'));
        const loginBtn = btns.find(b => /log.*in|sign.*in|ログイン/i.test(b.textContent || b.value || ''));
        if (loginBtn) loginBtn.click();
      });
    } else {
      // Re-auth flow: AMC is pre-filled and masked, only password is needed.
      // Use the specific #amcMemberLogin submit button instead of text matching,
      // because the page also has a "Stay Logged On" button that could confuse
      // the text-based search.
      this.log('Entering credentials (re-auth: password only, AMC pre-filled)...');
      await passField.click();
      await passField.type(password, { delay: 80 });
      await randomDelay(1000, 2000);

      const loginBtn = await page.$('#amcMemberLogin');
      if (loginBtn) {
        await loginBtn.click();
      } else {
        this.log('amcMemberLogin button missing — submitting via Enter');
        await passField.press('Enter');
      }
    }

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

  // Visit ana.co.jp, idle, jiggle the mouse, then come back to the search form.
  // Akamai weighs how long a "user" sits on the entry page before drilling into
  // the award flow — going from login straight to repeated searches looks like a bot.
  async _warmUp() {
    const page = this.page;
    try {
      this.log('Warming up...');
      await page.goto('https://www.ana.co.jp/en/jp/', {
        waitUntil: 'domcontentloaded', timeout: 30000,
      });
      await randomDelay(8000, 15000);

      const moveCount = 2 + Math.floor(Math.random() * 2); // 2 or 3
      const vp = page.viewport() || { width: 1280, height: 900 };
      for (let i = 0; i < moveCount; i++) {
        const x = Math.floor(Math.random() * vp.width);
        const y = Math.floor(Math.random() * vp.height);
        await page.mouse.move(x, y);
        this._mouseX = x;
        this._mouseY = y;
        await randomDelay(400, 1200);
      }

      const backUrl = this.sessionBaseUrl
        ? this.sessionBaseUrl + (this.sessionParams || '')
        : 'https://www.ana.co.jp/other/int/meta/0771.html?CONNECTION_KIND=us&LANG=e';
      await page.goto(backUrl, { waitUntil: 'networkidle2', timeout: 60000 });
      await randomDelay(2000, 4000);

      this.log('Warm-up done');
    } catch (e) {
      this.log(`Warm-up error (continuing): ${e.message}`);
    }
  }

  // Trace a curved cursor path from the current virtual position into `selector`.
  // Quadratic bezier with a random control-point offset so the path isn't a straight
  // line; 8-12 small steps with 20-40 ms gaps mimics human acceleration.
  // Lands slightly off-centre because dead-centre clicks are another bot tell.
  async _moveTo(page, selector) {
    try {
      const box = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return null;
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      }, selector);
      if (!box) return;

      const targetX = box.x + box.width * (0.3 + Math.random() * 0.4);
      const targetY = box.y + box.height * (0.3 + Math.random() * 0.4);
      const startX = this._mouseX;
      const startY = this._mouseY;

      // Control point offset perpendicular-ish to the line for curvature
      const ctrlX = (startX + targetX) / 2 + (Math.random() - 0.5) * 120;
      const ctrlY = (startY + targetY) / 2 + (Math.random() - 0.5) * 120;

      const steps = 8 + Math.floor(Math.random() * 5); // 8..12
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const u = 1 - t;
        const x = u * u * startX + 2 * u * t * ctrlX + t * t * targetX;
        const y = u * u * startY + 2 * u * t * ctrlY + t * t * targetY;
        await page.mouse.move(x, y);
        await new Promise(r => setTimeout(r, 20 + Math.floor(Math.random() * 21)));
      }

      this._mouseX = targetX;
      this._mouseY = targetY;
    } catch (e) {
      // Mouse pathing is a behavioural nicety — never let it kill a search.
    }
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
    const depHiddenSel = '#departureAirportCode\\:field';
    await this._moveTo(page, depTextSel);
    await page.click(depTextSel).catch(() => {});
    await randomDelay(300, 500);
    await page.evaluate((sel) => { document.querySelector(sel).value = ''; }, depTextSel);
    await page.type(depTextSel, from, { delay: 150 });
    await randomDelay(2000, 3000);
    await page.keyboard.press('ArrowDown');
    await randomDelay(300, 500);
    await page.keyboard.press('Enter');
    await randomDelay(1500, 2000);

    // Force-set the hidden departure field as a safety net. The autocomplete
    // flow above (ArrowDown + Enter) USUALLY updates the hidden field, but
    // intermittently fails when the dropdown is slow or doesn't trigger —
    // causing the previous search's value to persist and the wrong route
    // to be searched.
    await page.evaluate((sel, code) => {
      const hidden = document.querySelector(sel);
      if (hidden && hidden.value !== code) {
        hidden.value = code;
        hidden.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, depHiddenSel, from);

    // Fill arrival
    const arrTextSel = '#arrivalAirportCode\\:field_pctext';
    const arrHiddenSel = '#arrivalAirportCode\\:field';
    await this._moveTo(page, arrTextSel);
    await page.click(arrTextSel).catch(() => {});
    await randomDelay(300, 500);
    await page.evaluate((sel) => { document.querySelector(sel).value = ''; }, arrTextSel);
    await page.type(arrTextSel, to, { delay: 150 });
    await randomDelay(2000, 3000);
    await page.keyboard.press('ArrowDown');
    await randomDelay(300, 500);
    await page.keyboard.press('Enter');
    await randomDelay(1500, 2000);

    // Force-set the hidden arrival field (same safety net as departure)
    await page.evaluate((sel, code) => {
      const hidden = document.querySelector(sel);
      if (hidden && hidden.value !== code) {
        hidden.value = code;
        hidden.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, arrHiddenSel, to);

    // Verify both hidden fields match intended route before submitting
    const formCheck = await page.evaluate((depSel, arrSel) => {
      const dep = document.querySelector(depSel);
      const arr = document.querySelector(arrSel);
      return { dep: dep?.value, arr: arr?.value };
    }, depHiddenSel, arrHiddenSel);
    if (formCheck.dep !== from || formCheck.arr !== to) {
      this.log(`⚠️ Form field mismatch! Expected ${from}→${to}, got ${formCheck.dep}→${formCheck.arr}. Forcing...`);
      await page.evaluate((depSel, arrSel, fromCode, toCode) => {
        const dep = document.querySelector(depSel);
        const arr = document.querySelector(arrSel);
        if (dep) { dep.value = fromCode; dep.dispatchEvent(new Event('change', { bubbles: true })); }
        if (arr) { arr.value = toCode; arr.dispatchEvent(new Event('change', { bubbles: true })); }
      }, depHiddenSel, arrHiddenSel, from, to);
    }

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
      if (btn) {
        btn.scrollIntoView({ behavior: 'instant', block: 'center' });
        // Tag the button so _moveTo can find it via a stable selector
        btn.setAttribute('data-search-submit', '1');
        return true;
      }
      return false;
    });

    if (submitClicked) {
      await this._moveTo(page, 'input[type="submit"][data-search-submit="1"]');
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
async function runParallel(jobs, maxSessions = 4, lastChecked = {}, onResult = null) {
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
      // Stagger launches so two browsers aren't fingerprinting against Akamai
      // simultaneously from the same machine. Session 1 (i=0) starts immediately;
      // each subsequent session adds 20-40s of additional delay.
      const startDelay = i * (20000 + Math.random() * 20000);
      if (startDelay > 0) {
        session.log(`Staggered start: waiting ${Math.round(startDelay / 1000)}s before launch`);
        await new Promise(r => setTimeout(r, startDelay));
      }

      await session.launch();
      const ok = await session.navigateToSearchForm();
      if (!ok) {
        session.log('Could not reach search form — skipping');
        allResults.push({ _sessionFailed: true, error: 'Cookie expired or login failed', sessionId: i + 1 });
        return;
      }

      await session._warmUp();

      let consecutiveRateLimits = 0;
      for (const task of chunk) {
        try {
          const { results } = await session.searchDate(task);
          const resultEntry = {
            route: `${task.from}→${task.to}`,
            cabin: task.cabinName,
            date: task.date,
            results,
          };
          allResults.push(resultEntry);
          consecutiveRateLimits = 0; // success — reset counter

          // Fire per-result callback immediately so notifications go out
          // within seconds of discovery, not after the full batch finishes.
          // Await ensures the Discord message is sent before moving on.
          // Error is caught so a notification failure never kills a search.
          if (onResult) {
            try { await onResult(resultEntry); }
            catch (e) { session.log(`onResult callback error: ${e.message}`); }
          }
        } catch (err) {
          session.log(`Error searching ${task.date}: ${err.message}`);

          if (/Runtime\.callFunctionOn timed out|ProtocolError|Target closed/i.test(err.message)) {
            session._cdpDead = true;
            allResults.push({ route: `${task.from}→${task.to}`, cabin: task.cabinName, date: task.date, results: [], _timedOut: true });
            break;
          }

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
