/**
 * Optional resource blocking for bot Chrome pages — cuts the CPU / RAM / network
 * the off-screen bot windows spend decoding and painting things nobody looks at.
 *
 * Controlled by BOT_BLOCK_RESOURCES, a comma list of categories:
 *   images  — every Image request (hero banners, carousels, icons, CSS backgrounds)
 *   fonts   — web fonts (text falls back to system fonts)
 *   media   — <video>/<audio>
 * Unset / empty / "off" = block nothing (byte-identical to before).
 *
 * How: a dedicated CDP session enables the Fetch domain with patterns for ONLY
 * those resource types, and fails each paused request with BlockedByClient.
 * Chrome classifies the resource type itself, so this matches by what the
 * request is, not by URL. (Network.setBlockedURLs was rejected: its wildcard
 * treats `?` as "any one char", so `*.ico?*` also blocks `/x.icon.js`.)
 * Requests of other types are never paused — no per-request Node round-trip —
 * and unlike puppeteer's setRequestInterception the HTTP cache stays on.
 *
 * What is NEVER blocked: documents, scripts, XHR/fetch, stylesheets, pings.
 * Akamai's sensor (first-party JS + XHR/beacon POSTs) and ANA's JSF form
 * scripts load untouched, and the parser reads `addFormatedRecommendation(...)`
 * calls out of the HTML — none of that depends on images, fonts or media.
 */

const CATEGORY_TYPES = {
  images: 'Image',
  fonts: 'Font',
  media: 'Media',
};

/**
 * @param {string|undefined} raw  BOT_BLOCK_RESOURCES value
 * @returns {{ categories: string[], unknown: string[] }}
 */
function parseBlockList(raw) {
  const out = { categories: [], unknown: [] };
  if (raw == null) return out;
  const items = String(raw).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (items.length === 0 || items.includes('off') || items.includes('none')) return out;
  for (const item of items) {
    if (CATEGORY_TYPES[item]) {
      if (!out.categories.includes(item)) out.categories.push(item);
    } else {
      out.unknown.push(item);
    }
  }
  return out;
}

/** Fetch.enable patterns for the chosen categories (request stage only). */
function fetchPatterns(categories) {
  return categories.filter(c => CATEGORY_TYPES[c]).map(c => ({ resourceType: CATEGORY_TYPES[c], requestStage: 'Request' }));
}

/**
 * Apply BOT_BLOCK_RESOURCES to a puppeteer page. Never throws — blocking is a
 * load optimisation and must not be able to fail a search or keep-alive.
 *
 * @returns {Promise<string[]>} the categories actually applied
 */
async function applyResourceBlocking(page, { env = process.env, log = null } = {}) {
  const { categories, unknown } = parseBlockList(env.BOT_BLOCK_RESOURCES);
  if (unknown.length && log) {
    log(`BOT_BLOCK_RESOURCES: ignoring unknown categor${unknown.length > 1 ? 'ies' : 'y'} ${unknown.join(', ')} (valid: ${Object.keys(CATEGORY_TYPES).join(', ')})`);
  }
  if (categories.length === 0) return [];
  try {
    const cdp = await page.createCDPSession();
    // Fail fast and never let a paused request hang: if the session is gone
    // the target is gone too, so the swallowed rejection is harmless.
    cdp.on('Fetch.requestPaused', ({ requestId }) => {
      cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }).catch(() => {});
    });
    await cdp.send('Fetch.enable', { patterns: fetchPatterns(categories) });
    if (log) log(`Blocking ${categories.join(', ')} to reduce load`);
    return categories;
  } catch (e) {
    if (log) log(`Resource blocking unavailable (continuing without): ${e.message}`);
    return [];
  }
}

module.exports = { CATEGORY_TYPES, parseBlockList, fetchPatterns, applyResourceBlocking };
