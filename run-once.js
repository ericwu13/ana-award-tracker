/**
 * Single-run scraper — runs one check cycle and exits.
 * Designed to be called by Task Scheduler via run-check.vbs.
 * Cookie server runs in the persistent Discord bot process (discord-bot.js).
 */
const fs = require('fs');
const path = require('path');
const LOCK_FILE = path.join(__dirname, 'data', 'run.lock');

function acquireLock() {
  if (fs.existsSync(LOCK_FILE)) {
    try {
      const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
      process.kill(pid, 0); // throws if dead
      console.log(`[run-once] Another run already in progress (PID ${pid}), exiting.`);
      process.exit(0);
    } catch (e) {
      // stale lock — overwrite
    }
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid));
}

function releaseLock() {
  try { fs.unlinkSync(LOCK_FILE); } catch (_) {}
}

acquireLock();
process.on('exit', releaseLock);
process.on('uncaughtException', (e) => { releaseLock(); throw e; });
process.on('SIGTERM', () => { releaseLock(); process.exit(0); });

require('dotenv').config();

// Load and run the main index
require('./src/index.js');
