/**
 * Session staleness tracker.
 * When cookies are known to be stale (re-auth failed), all components
 * stop making requests to ANA until fresh cookies arrive.
 * Prevents hammering ANA with failed login attempts.
 */
const fs = require('fs');
const path = require('path');

const FLAG_FILE = path.join(__dirname, '..', 'data', 'session-stale.flag');

function markStale(reason) {
  fs.writeFileSync(FLAG_FILE, JSON.stringify({
    staleAt: new Date().toISOString(),
    reason,
  }));
  console.log(`[Session] Marked STALE: ${reason}`);
}

function clearStale() {
  try {
    if (fs.existsSync(FLAG_FILE)) {
      fs.unlinkSync(FLAG_FILE);
      console.log('[Session] Stale flag cleared — fresh cookies received');
    }
  } catch {}
}

function isStale() {
  return fs.existsSync(FLAG_FILE);
}

function getStaleInfo() {
  try {
    return JSON.parse(fs.readFileSync(FLAG_FILE, 'utf8'));
  } catch {
    return null;
  }
}

module.exports = { markStale, clearStale, isStale, getStaleInfo };
