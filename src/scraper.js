const { connect } = require('puppeteer-real-browser');
const fs = require('fs');
const path = require('path');
const { parseResults, getPageDebugInfo } = require('./parser');

let browserInstance = null;
let pageInstance = null;
let sessionBaseUrl = null; // e.g. https://aswbe-i.ana.co.jp/rei11g/international_asw/pages/award/search/roundtrip/award_search_roundtrip_input.xhtml
let sessionParams = null;  // e.g. ?aswcid=1&rand=...&rdtk=...

const COOKIE_PATH = path.join(__dirname, '..', 'data', 'cookies.json');

/** Save cookies to disk so we can restore the session later */
async function saveCookies(page) {
  try {
    const cookies = await page.cookies();
    fs.mkdirSync(path.dirname(COOKIE_PATH), { recursive: true });
    fs.writeFileSync(COOKIE_PATH, JSON.stringify(cookies, null, 2));
    console.log('[Scraper] Cookies saved');
  } catch (e) {
    console.log('[Scraper] Could not save cookies:', e.message);
  }
}

/** Restore cookies from disk */
async function loadCookies(page) {
  try {
    if (fs.existsSync(COOKIE_PATH)) {
      const cookies = JSON.parse(fs.readFileSync(COOKIE_PATH, 'utf8'));
      if (cookies.length > 0) {
        await page.setCookie(...cookies);
        console.log(`[Scraper] Restored ${cookies.length} cookies from disk`);
        return true;
      }
    }
  } catch (e) {
    console.log('[Scraper] Could not load cookies:', e.message);
  }
  return false;
}

/**
 * Check if the page is showing ANA's dedicated rate-limit / maintenance error page.
 *
 * The actual block page is a minimal page with just the error message and a copyright
 * footer — no forms, no navigation, no search fields. We check for the specific
 * full error sentences AND verify the page is structurally an error page (very few
 * interactive elements) to avoid false positives from normal pages that might mention
 * "heavy traffic" in help/hint sections.
 */
async function isRateLimited(page) {
  const limited = await page.evaluate(() => {
    const text = document.body?.innerText || '';

    // The exact sentences on ANA's block page
    const hasBlockMessage =
      text.includes('Your request cannot be accepted at this time') ||
      text.includes('ただいま大変混み合っているか、コンピュータの調整中です');

    if (!hasBlockMessage) return false;

    // Confirm it's actually the dedicated error page, not a normal page
    // with the phrase buried in a help section. The block page has no
    // forms, no inputs, no search fields — it's nearly empty.
    const inputCount = document.querySelectorAll('input, select, textarea').length;
    const hasSearchForm = !!document.querySelector('#departureAirportCode\\:field_pctext, #accountNumber, form[action*="award"]');

    // The real block page has 0 inputs and no search/login form
    return inputCount === 0 && !hasSearchForm;
  });
  return limited;
}

/** Random delay to appear human */
function randomDelay(minMs = 2000, maxMs = 5000) {
  const ms = Math.floor(Math.random() * (maxMs - minMs)) + minMs;
  return new Promise(r => setTimeout(r, ms));
}

/** Type text character by character with random delays */
async function humanType(page, selector, text) {
  await page.click(selector);
  await randomDelay(300, 600);
  // Clear existing text
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el) el.value = '';
  }, selector);
  for (const char of text) {
    await page.type(selector, char, { delay: Math.floor(Math.random() * 150) + 50 });
  }
}

async function getBrowser() {
  if (browserInstance && browserInstance.connected) return { browser: browserInstance, page: pageInstance };

  const chromeProfileDir = process.env.CHROME_PROFILE_DIR;
  const chromeProfile = process.env.CHROME_PROFILE || 'Default';
  const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

  const args = [
    '--start-minimized',
    '--window-position=-1920,679',
    '--window-size=1280,900',
  ];

  // Use the user's real Chrome profile if configured — inherits cookies, session, fingerprint
  if (chromeProfileDir) {
    console.log(`[Scraper] Launching YOUR Chrome (${chromePath}) with profile: ${chromeProfile}`);
    args.push(`--user-data-dir=${chromeProfileDir}`);
    args.push(`--profile-directory=${chromeProfile}`);
  } else {
    console.log('[Scraper] Launching browser (fresh profile)...');
  }

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
    console.log('[Scraper] Browser disconnected');
    browserInstance = null;
    pageInstance = null;
  });

  browserInstance = browser;
  pageInstance = page;
  return { browser, page };
}

async function closeBrowser() {
  console.log('[Scraper] Closing browser...');
  if (browserInstance) {
    try { await browserInstance.close(); } catch (e) {}
    browserInstance = null;
    pageInstance = null;
  }
}

/**
 * Login to ANA Mileage Club and navigate to the award search form.
 *
 * Strategy: Use the 0771 meta-redirect page on ana.co.jp to get proper session
 * tokens (rand, rdtk, /rei##x/ path prefix). Going directly to aswbe-i.ana.co.jp
 * without these tokens gets rejected with a "heavy traffic" page.
 *
 * Flow: 0771 redirect → aswbe-i login page (with tokens) → login → search form
 */
async function login(page, username, password) {
  console.log('[Scraper] Starting login via ANA front door...');

  // Try restoring cookies before navigating (may skip login entirely)
  await loadCookies(page);

  // Step 1: Use the 0771 redirect to get a session with proper tokens.
  // This redirects to: aswbe-i.ana.co.jp/rei##x/.../login_standard.xhtml?aswcid=1&rand=...&rdtk=...
  // If cookies are valid, it may go straight to the search form.
  console.log('[Scraper] Step 1: Navigating to award search via 0771 redirect...');
  await page.goto('https://www.ana.co.jp/other/int/meta/0771.html?CONNECTION_KIND=us&LANG=e', {
    waitUntil: 'networkidle2', timeout: 60000,
  });
  await randomDelay(3000, 5000);

  const currentUrl = await page.url();
  console.log(`[Scraper] Landed on: ${currentUrl}`);

  // Check if we landed on the search form (cookies worked, already authenticated)
  const isOnSearchForm = await page.evaluate(() => {
    const text = document.body.innerText || '';
    return text.includes('Departure') || text.includes('Origin') ||
           text.includes('Award Reservation') || text.includes('出発地') ||
           text.includes('フライト検索');
  });

  if (isOnSearchForm) {
    console.log('[Scraper] ✅ Already logged in — on award search form (cookies worked!)');
    await saveCookies(page);
    _saveSessionUrl(currentUrl);
    return true;
  }

  // Check for the "heavy traffic" rejection (Akamai bot detection)
  if (await isRateLimited(page)) {
    console.error('[Scraper] ⛔ ANA/Akamai blocked us — cookies may have expired');
    console.error('[Scraper] Re-export cookies: log in via Chrome, use the ANA Cookie Exporter extension');
    const err = new Error('RATE_LIMITED');
    err.rateLimited = true;
    throw err;
  }

  // Step 2: We're on the login page. Try to log in (may fail due to Akamai bot detection).
  console.log('[Scraper] ⚠️ Cookies expired — attempting login (may be blocked by Akamai)...');
  console.log('[Scraper] Step 2: On login page, entering credentials...');

  // Save screenshot for debugging
  const loginScreenPath = path.join(__dirname, '..', 'data', 'login-screen-debug.png');
  await page.screenshot({ path: loginScreenPath, fullPage: true }).catch(() => {});

  // Dismiss any overlays (cookie consent, popups, etc.)
  await page.evaluate(() => {
    const dismissTexts = /accept|agree|close|dismiss|got it|ok|consent/i;
    const btns = Array.from(document.querySelectorAll('button, a, [role="button"]'));
    const overlay = btns.find(b => dismissTexts.test(b.textContent || ''));
    if (overlay) overlay.click();
  });
  await randomDelay(1000, 2000);

  // Look for login fields
  const usernameSelectors = [
    '#accountNumber', '#amcNumber', '#memberNumber',
    'input[name*="account"]', 'input[name*="member"]', 'input[name*="number"]',
    'input[name*="AMC"]', 'input[name*="amc"]',
    'input[type="text"]', 'input[type="tel"]',
  ];

  const passwordSelectors = [
    '#password', '#webPassword',
    'input[name*="password"]', 'input[name*="Password"]',
    'input[type="password"]',
  ];

  let usernameSelector = null, passwordSelector = null;
  for (const sel of usernameSelectors) {
    if (await page.$(sel)) { usernameSelector = sel; break; }
  }
  for (const sel of passwordSelectors) {
    if (await page.$(sel)) { passwordSelector = sel; break; }
  }

  if (!usernameSelector || !passwordSelector) {
    const debug = await getPageDebugInfo(page);
    console.error('[Scraper] Could not find login fields. Page info:', JSON.stringify(debug, null, 2));
    const screenshotPath = path.join(__dirname, '..', 'data', 'login-debug.png');
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    throw new Error('Login form not found');
  }

  console.log(`[Scraper] Found login fields: ${usernameSelector}, ${passwordSelector}`);

  // Enter credentials
  await page.evaluate((uSel, pSel, user, pass) => {
    const uEl = document.querySelector(uSel);
    const pEl = document.querySelector(pSel);
    if (uEl) {
      uEl.focus();
      uEl.value = user;
      uEl.dispatchEvent(new Event('input', { bubbles: true }));
      uEl.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (pEl) {
      pEl.focus();
      pEl.value = pass;
      pEl.dispatchEvent(new Event('input', { bubbles: true }));
      pEl.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, usernameSelector, passwordSelector, username, password);

  await randomDelay(1000, 2000);

  // Submit login
  const submitClicked = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button, input[type="submit"]'));
    const loginBtn = btns.find(b => /log\s*in|sign\s*in|submit|ログイン/i.test(b.textContent || b.value || ''));
    if (loginBtn) { loginBtn.click(); return true; }
    const form = document.querySelector('form');
    if (form) { form.submit(); return true; }
    return false;
  });

  if (submitClicked) {
    console.log('[Scraper] Submitted login form');
  } else {
    await page.keyboard.press('Enter');
    console.log('[Scraper] Pressed Enter to submit');
  }

  await randomDelay(3000, 5000);
  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
  await randomDelay(2000, 3000);

  // After login, ANA should redirect us to the award search form
  const postLoginUrl = await page.url();
  console.log(`[Scraper] Post-login URL: ${postLoginUrl}`);

  // Wait for redirect chain to complete
  for (let i = 0; i < 5; i++) {
    const hasForm = await page.$('#departureAirportCode\\:field_pctext');
    if (hasForm) {
      console.log('[Scraper] ✅ Landed on search form after login');
      break;
    }
    const url = await page.url();
    if (url.includes('login') || url.includes('Login')) {
      console.log(`[Scraper] Still on login page, waiting... (attempt ${i + 1})`);
      await randomDelay(3000, 5000);
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
    } else {
      break;
    }
  }

  const finalUrl = await page.url();
  const onSearchForm = await page.evaluate(() => {
    const text = document.body.innerText || '';
    return text.includes('Departure') || text.includes('Origin') ||
           text.includes('Award Reservation') || text.includes('出発地') ||
           text.includes('フライト検索');
  });

  if (onSearchForm) {
    console.log('[Scraper] ✅ On award search form with valid session');
    await saveCookies(page);
    _saveSessionUrl(finalUrl);
  } else {
    console.log('[Scraper] ⚠️ Not on search form — saving debug screenshot');
    const screenshotPath = path.join(__dirname, '..', 'data', 'post-login-debug.png');
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    const debug = await getPageDebugInfo(page);
    console.log('[Scraper] Page debug:', JSON.stringify(debug, null, 2));
  }

  return onSearchForm;
}

/** Extract and save the session base URL from a fully-qualified award search URL */
function _saveSessionUrl(url) {
  try {
    if (url.includes('aswbe-i.ana.co.jp')) {
      const urlObj = new URL(url);
      sessionBaseUrl = `${urlObj.origin}${urlObj.pathname}`;
      sessionParams = urlObj.search;
      console.log(`[Scraper] Session base saved: ${sessionBaseUrl}`);
    }
  } catch (e) {}
}

/**
 * Navigate to award search and fill in search parameters.
 */
async function searchAwardFlights(page, { from = 'TPE', to = 'SFO', date, cabinCode = 'CFF1' }) {
  console.log(`[Scraper] Searching award flights: ${from}→${to} on ${date}`);

  // Check if we're already on the search form (first search after login)
  const alreadyOnForm = await page.evaluate(() => {
    return !!document.querySelector('#departureAirportCode\\:field_pctext');
  });

  if (!alreadyOnForm) {
    // Navigate back to the search form — use session URL if we have one, otherwise
    // go through the entry redirect to get proper tokens
    if (sessionBaseUrl) {
      console.log(`[Scraper] Navigating to search form via session URL...`);
      await page.goto(sessionBaseUrl + (sessionParams || ''), {
        waitUntil: 'networkidle2', timeout: 60000,
      });
    } else {
      console.log('[Scraper] No session URL — going through entry redirect...');
      await page.goto('https://www.ana.co.jp/other/int/meta/0771.html?CONNECTION_KIND=us&LANG=e', {
        waitUntil: 'networkidle2', timeout: 60000,
      });
    }
    await randomDelay(3000, 5000);
  } else {
    console.log('[Scraper] Already on search form');
  }

  const currentUrl = await page.url();
  console.log(`[Scraper] Search page URL: ${currentUrl}`);

  // Check for session rejection
  if (await isRateLimited(page)) {
    console.error('[Scraper] ⛔ Session rejected on search page');
    const err = new Error('RATE_LIMITED');
    err.rateLimited = true;
    throw err;
  }

  const needsLogin = await page.evaluate(() => {
    const url = window.location.href;
    return url.includes('login') || url.includes('Login');
  });

  if (needsLogin) {
    console.log('[Scraper] Session expired, need to re-login');
    return { needsLogin: true };
  }

  // Save debug screenshot
  const screenshotPath = path.join(__dirname, '..', 'data', `search-form-${date}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});

  // Switch to one-way search using Puppeteer click (not evaluate) for proper event handling
  const owSelector = '[id*="oneway"], [id*="oneWay"], input[value="oneway"]';
  const owEl = await page.$(owSelector);
  if (owEl) {
    console.log('[Scraper] Clicking one-way tab...');
    await owEl.click();
    // Wait for JSF AJAX to complete — the page partially reloads
    await randomDelay(3000, 5000);
    // Wait for any AJAX requests to finish
    await page.waitForFunction(() => {
      // Check if any XHR/fetch is pending
      return document.readyState === 'complete';
    }, { timeout: 10000 }).catch(() => {});
    await randomDelay(1000, 2000);
    console.log('[Scraper] Switched to one-way');
  } else {
    console.log('[Scraper] One-way tab not found, using roundtrip');
  }

  // Take a screenshot of the search form for debugging
  const formDebugPath = path.join(__dirname, '..', 'data', `search-form-debug-${date}.png`);
  await page.screenshot({ path: formDebugPath, fullPage: true }).catch(() => {});

  // === SELECT CABIN CLASS ===
  console.log(`[Scraper] Setting cabin class: ${cabinCode}`);
  const cabinOptions = await page.evaluate(() => {
    const sel = document.querySelector('#boardingClass');
    if (!sel) return null;
    return Array.from(sel.options).map(o => ({ value: o.value, text: o.textContent.trim() }));
  });
  console.log(`[Scraper] Available cabin options: ${JSON.stringify(cabinOptions)}`);
  await page.select('#boardingClass', cabinCode).catch(() => {
    console.log('[Scraper] Could not select boardingClass via select(), trying evaluate');
  });
  await page.evaluate((code) => {
    const sel = document.querySelector('#boardingClass');
    if (sel) { sel.value = code; sel.dispatchEvent(new Event('change', { bubbles: true })); }
  }, cabinCode);
  await randomDelay(1000, 2000);

  // Quick field inventory (IDs only, no values — keep logs clean)
  const fieldCount = await page.evaluate(() => {
    const inputs = document.querySelectorAll('input, select');
    return `${inputs.length} fields found`;
  });
  console.log(`[Scraper] Form: ${fieldCount}`);

  // Fill form using actual UI interactions (JSF needs proper component events)
  const [year, month, day] = date.split('-');
  
  // === DEPARTURE AIRPORT (type + ArrowDown + Enter for autocomplete) ===
  console.log('[Scraper] Filling departure airport...');
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
  
  const depVal = await page.evaluate(() => {
    const h = document.querySelector('#departureAirportCode\\:field') || document.querySelector('input[name="departureAirportCode:field"]');
    return h ? h.value : '';
  });
  console.log(`[Scraper] Departure: ${depVal || 'EMPTY'}`);

  // === ARRIVAL AIRPORT ===
  console.log('[Scraper] Filling arrival airport...');
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

  const arrVal = await page.evaluate(() => {
    const h = document.querySelector('#arrivalAirportCode\\:field') || document.querySelector('input[name="arrivalAirportCode:field"]');
    return h ? h.value : '';
  });
  console.log(`[Scraper] Arrival: ${arrVal || 'EMPTY'}`);

  // === DATE ===
  // Strategy: Set both the visible text field and hidden field directly, then use
  // the calendar as a backup. The visible field format is "MM/DD/YYYY" and the
  // hidden field is "YYYY/MM/DD".
  console.log('[Scraper] Setting date...');
  const dateTextSel = '#awardDepartureDate\\:field_pctext';
  const dateHiddenSel = '#awardDepartureDate\\:field';
  // ANA date formats (from onclick: selectedDateFormat='%M/%D/%y (%w)', dateFrom='YYYYMMDD')
  const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const dateObj = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
  const dayOfWeek = dayNames[dateObj.getDay()];
  const visibleDate = `${month}/${day}/${year} (${dayOfWeek})`;  // "04/05/2026 (Sun)"
  const hiddenDate = `${year}${month}${day}`;                     // "20260405"

  // Try clicking the date field to open calendar, then pick the date
  await page.click(dateTextSel).catch(() => {});
  await randomDelay(2000, 3000);

  const targetYear = parseInt(year);
  const targetMonth = parseInt(month);
  const targetDay = parseInt(day);

  // Month name mapping — use FULL names since ANA's English calendar uses them
  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const monthNamesShort = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const targetMonthName = monthNamesShort[targetMonth - 1];
  const targetMonthFull = monthNames[targetMonth - 1];

  const calResult = await page.evaluate(async (tYear, tMonth, tDay, tMonthName) => {
    const results = [];
    
    // Wait for calendar to render
    await new Promise(r => setTimeout(r, 500));
    
    // Check if calendar modal is visible
    const calModal = document.querySelector('#awardDepartureDate\\:field_pctext_view');
    if (!calModal || calModal.offsetParent === null) {
      results.push('Calendar modal NOT visible');
      return results;
    }
    results.push('Calendar modal is open');

    // Find "Next 3 months" button inside the modal
    const navLinks = calModal.querySelectorAll('a, button, span');
    let nextBtn = null;
    for (const el of navLinks) {
      const text = el.textContent.trim();
      if (/next|次/i.test(text)) {
        nextBtn = el;
        break;
      }
    }
    results.push(`Next button: ${nextBtn ? nextBtn.textContent.trim() : 'not found'}`);

    // Check which months are currently visible
    function getVisibleMonths() {
      // Search ALL text nodes in the calendar for month/year patterns
      const allText = calModal.textContent;
      const months = [];
      
      // English: "April 2026", "Feb 2027", "March 2026"
      const shortToShort = { January:'Jan', February:'Feb', March:'Mar', April:'Apr', May:'May', June:'Jun', July:'Jul', August:'Aug', September:'Sep', October:'Oct', November:'Nov', December:'Dec' };
      const enMatches = allText.matchAll(/\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})/g);
      for (const m of enMatches) {
        const name = shortToShort[m[1]] || m[1]; // Normalize to short form
        months.push({ name, year: parseInt(m[2]), text: m[0] });
      }
      
      // Japanese: "2026年3月" 
      const jpMatches = allText.matchAll(/(\d{4})年(\d{1,2})月/g);
      const jpMonthMap = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      for (const m of jpMatches) {
        const yr = parseInt(m[1]);
        const mo = parseInt(m[2]);
        months.push({ name: jpMonthMap[mo], year: yr, text: m[0], monthNum: mo });
      }
      
      return months;
    }

    // Navigate forward until target month is visible (max 5 clicks = 15 months forward)
    for (let i = 0; i < 5; i++) {
      const visible = getVisibleMonths();
      results.push(`Visible months: ${visible.map(m => m.text).join(', ')}`);
      
      // Check if target month is visible
      const found = visible.some(m => m.name === tMonthName && m.year === tYear);
      if (found) {
        results.push('Target month is visible!');
        break;
      }
      
      if (!nextBtn) {
        results.push('No next button to navigate');
        break;
      }
      
      nextBtn.click();
      await new Promise(r => setTimeout(r, 1000));
      
      // Re-find next button (DOM may have changed)
      const newNavLinks = calModal.querySelectorAll('a, button, span');
      nextBtn = null;
      for (const el of newNavLinks) {
        if (/next|次/i.test(el.textContent.trim())) { nextBtn = el; break; }
      }
    }

    // Find the correct month section and click the target day
    // The calendar structure: each month has a heading (caption/th/h4/div) followed by a table
    // Let's find all month sections by looking at the DOM structure
    let clicked = false;
    
    // Strategy: find the text node with the target month/year, then find the nearest table
    const allElements = calModal.querySelectorAll('*');
    let targetTable = null;
    
    for (const el of allElements) {
      const text = el.textContent.trim();
      const directText = el.childNodes.length === 1 && el.childNodes[0].nodeType === 3 ? el.childNodes[0].textContent.trim() : '';
      
      // Match month heading - English (full or short) or Japanese
      const monthFull = ['','January','February','March','April','May','June','July','August','September','October','November','December'][tMonth];
      const isTarget = ((directText.includes(tMonthName) || directText.includes(monthFull)) && directText.includes(String(tYear))) ||
                       (directText.includes(`${tYear}年${tMonth}月`));
      
      if (isTarget) {
        results.push(`Found month heading: "${directText}" in ${el.tagName}`);
        // Find the nearest table after this heading
        let sibling = el.nextElementSibling;
        while (sibling) {
          if (sibling.tagName === 'TABLE') { targetTable = sibling; break; }
          const innerTable = sibling.querySelector('table');
          if (innerTable) { targetTable = innerTable; break; }
          sibling = sibling.nextElementSibling;
        }
        // Also check parent for table
        if (!targetTable) {
          const parent = el.closest('div, section, article');
          if (parent) targetTable = parent.querySelector('table');
        }
        break;
      }
    }

    // Fallback: if we can't find by heading, try all tables and match by month position
    if (!targetTable) {
      results.push('No heading match, trying table-by-position fallback');
      const tables = calModal.querySelectorAll('table');
      results.push(`Found ${tables.length} tables in calendar`);
      
      // Each table represents one month; the visible months tell us which table is which
      const visibleNow = getVisibleMonths();
      for (let i = 0; i < Math.min(tables.length, visibleNow.length); i++) {
        if (visibleNow[i].name === tMonthName && visibleNow[i].year === tYear) {
          targetTable = tables[i];
          results.push(`Matched table #${i} to ${visibleNow[i].text}`);
          break;
        }
      }
    }

    if (targetTable) {
      // Click the target day - try <a> links first, then <td> cells
      const clickables = targetTable.querySelectorAll('td a, td');
      for (const cell of clickables) {
        const cellText = cell.textContent.trim();
        if (cellText === String(tDay)) {
          const isDisabled = cell.classList.contains('disabled') || cell.classList.contains('past') || 
                            cell.parentElement?.classList.contains('disabled');
          if (!isDisabled) {
            cell.click();
            results.push(`Clicked day ${tDay} in target table`);
            clicked = true;
            break;
          }
        }
      }
    }

    if (!clicked) {
      results.push(`Could not click day ${tDay}`);
      // Last resort: dump calendar HTML for debugging
      results.push(`Calendar HTML (first 1000 chars): ${calModal.innerHTML.substring(0, 1000)}`);
    }

    return results;
  }, targetYear, targetMonth, targetDay, targetMonthName);

  console.log('[Scraper] Calendar navigation:', JSON.stringify(calResult));
  await randomDelay(1500, 2500);
  
  // Check if hidden fields got populated by the UI interactions
  const hiddenFieldCheck = await page.evaluate(() => {
    const dep = document.querySelector('#departureAirportCode\\:field') || document.querySelector('input[name="departureAirportCode:field"]');
    const arr = document.querySelector('#arrivalAirportCode\\:field') || document.querySelector('input[name="arrivalAirportCode:field"]');
    const date = document.querySelector('#awardDepartureDate\\:field') || document.querySelector('input[name="awardDepartureDate:field"]');
    return {
      departure: dep ? dep.value : 'NOT FOUND',
      arrival: arr ? arr.value : 'NOT FOUND',
      date: date ? date.value : 'NOT FOUND',
    };
  });
  console.log('[Scraper] Hidden field values after UI interaction:', JSON.stringify(hiddenFieldCheck));

  // Force-set hidden fields as fallback (calendar may have failed)
  console.log('[Scraper] Setting hidden fields directly as fallback...');
  await page.evaluate((fromCode, toCode, dateStr, visDate) => {
    const dep = document.querySelector('#departureAirportCode\\:field') || document.querySelector('input[name="departureAirportCode:field"]');
    const arr = document.querySelector('#arrivalAirportCode\\:field') || document.querySelector('input[name="arrivalAirportCode:field"]');
    const dt = document.querySelector('#awardDepartureDate\\:field') || document.querySelector('input[name="awardDepartureDate:field"]');
    const dtText = document.querySelector('#awardDepartureDate\\:field_pctext');
    if (dep && !dep.value) dep.value = fromCode;
    if (arr && !arr.value) arr.value = toCode;
    // Always set date (calendar often fails)
    if (dt) { dt.value = dateStr; dt.dispatchEvent(new Event('change', { bubbles: true })); }
    if (dtText) { dtText.value = visDate; }
  }, from, to, hiddenDate, visibleDate);

  // Enable class comparison checkbox
  await page.evaluate(() => {
    const cb = document.querySelector('#comparisonSearchType');
    if (cb && !cb.checked) cb.click();
  });
  
  await randomDelay(1000, 2000);

  // Take screenshot before submitting
  const preSubmitPath = path.join(__dirname, '..', 'data', `pre-submit-${date}.png`);
  await page.screenshot({ path: preSubmitPath, fullPage: true }).catch(() => {});

  // Close any open modals/overlays (calendar might still be open)
  await page.evaluate(() => {
    // Click the mask/overlay to close the calendar
    const mask = document.querySelector('#maskForClose');
    if (mask && mask.offsetParent !== null) mask.click();
    // Also try close button
    const closeBtn = document.querySelector('.modalCloseButton a, .modalCloseButton button');
    if (closeBtn) closeBtn.click();
  });
  await randomDelay(1000, 1500);
  
  // Screenshot before submit
  const preSubmitPath2 = path.join(__dirname, '..', 'data', `pre-submit2-${date}.png`);
  await page.screenshot({ path: preSubmitPath2, fullPage: true }).catch(() => {});

  // Submit search
  console.log('[Scraper] Submitting search...');
  
  // Find and click the EXACT search button (検索する), not the session keepalive button
  const submitClicked = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('input[type="submit"]'));
    // First priority: exact match on 検索する
    let btn = btns.find(b => b.value === '検索する');
    // Second: English "Search"
    if (!btn) btn = btns.find(b => b.value === 'Search');
    // Third: button with btnWidthVariable class (the main search button)
    if (!btn) btn = btns.find(b => b.className.includes('btnWidthVariable'));
    
    if (btn) {
      btn.scrollIntoView({ behavior: 'instant', block: 'center' });
      return { found: true, name: btn.name, value: btn.value, cls: btn.className.substring(0, 80) };
    }
    // Debug: list all submit buttons
    return { found: false, allBtns: btns.map(b => ({ name: b.name, value: b.value })) };
  });
  console.log('[Scraper] Submit button:', JSON.stringify(submitClicked));
  
  if (submitClicked.found) {
    await randomDelay(500, 1000);
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('input[type="submit"]'));
      let btn = btns.find(b => b.value === '検索する');
      if (!btn) btn = btns.find(b => b.value === 'Search');
      if (!btn) btn = btns.find(b => b.className.includes('btnWidthVariable'));
      if (btn) btn.click();
    });
    console.log('[Scraper] Clicked search button via JS');
  }

  // Wait for results
  await randomDelay(3000, 5000);
  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {
    console.log('[Scraper] Navigation timeout - page may have loaded via AJAX');
  });
  await randomDelay(2000, 4000);

  // Check for rate-limiting on the results page
  if (await isRateLimited(page)) {
    console.error('[Scraper] ⛔ Rate-limited on results page');
    const err = new Error('RATE_LIMITED');
    err.rateLimited = true;
    throw err;
  }

  // Save results screenshot
  const resultsPath = path.join(__dirname, '..', 'data', `results-${date}.png`);
  await page.screenshot({ path: resultsPath, fullPage: true }).catch(() => {});

  // Parse results
  const results = await parseResults(page, cabinCode === 'CFF1' ? 'Economy' : cabinCode === 'CFF2' ? 'Business' : cabinCode === 'CFF4' ? 'Premium Economy' : 'First');
  console.log(`[Scraper] Found ${results.length} result(s) for ${date}`);

  if (results.length === 0) {
    const debug = await getPageDebugInfo(page);
    console.log('[Scraper] Page debug info:', JSON.stringify(debug, null, 2));
  }

  return { results, needsLogin: false };
}

/**
 * Main scrape function: login and check all dates.
 */
async function checkAvailability(config) {
  const { username, password, dates, from = 'TPE', to = 'SFO', cabinCode = 'CFF1', cabinName = 'Economy', skipLogin = false } = config;
  const { browser, page } = await getBrowser();

  try {
    // Login (skip if caller says session is already authenticated)
    if (!skipLogin) {
      await login(page, username, password);
      await randomDelay(2000, 4000);
    } else {
      console.log('[Scraper] Skipping login — reusing existing session');
    }

    const allResults = [];

    for (const date of dates) {
      console.log(`\n[Scraper] === Checking ${date} ===`);
      
      const { results, needsLogin } = await searchAwardFlights(page, { from, to, date, cabinCode });

      if (needsLogin) {
        console.log('[Scraper] Re-logging in...');
        await login(page, username, password);
        await randomDelay(2000, 3000);
        const retry = await searchAwardFlights(page, { from, to, date, cabinCode });
        allResults.push({ date, results: retry.results });
      } else {
        allResults.push({ date, results });
      }

      // Delay between searches
      if (dates.indexOf(date) < dates.length - 1) {
        await randomDelay(3000, 6000);
      }
    }

    return allResults;
  } catch (err) {
    console.error('[Scraper] Error:', err.message);
    
    // Save error screenshot
    const errorPath = path.join(__dirname, '..', 'data', 'error-debug.png');
    await page.screenshot({ path: errorPath, fullPage: true }).catch(() => {});
    
    throw err;
  }
}

module.exports = { checkAvailability, closeBrowser, getBrowser };
