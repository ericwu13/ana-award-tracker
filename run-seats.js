/**
 * seats.aero scan — runs one cycle and exits. Schedule it with Task Scheduler
 * via run-seats.vbs every 30 min (or more often: the cycle self-paces to
 * SEATS_AERO_INTERVAL_MIN and the daily call budget, so extra ticks just exit).
 *
 * Independent of run-once.js (ANA): no browser, no cookies, its own lock and
 * its own state file (data/seats-state.json). `--force` ignores the interval.
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const LOCK_FILE = path.join(__dirname, 'data', 'seats.lock');

function acquireLock() {
  fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
  if (fs.existsSync(LOCK_FILE)) {
    try {
      const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
      process.kill(pid, 0);
      console.log(`[seats] Another scan is running (PID ${pid}), exiting.`);
      process.exit(0);
    } catch (_) { /* stale lock */ }
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid));
}
function releaseLock() { try { fs.unlinkSync(LOCK_FILE); } catch (_) {} }

async function main() {
  acquireLock();
  process.on('exit', releaseLock);

  const { loadRoutes, usesSource, minBookableDate } = require('./src/routes');
  const { runSeatsCycle, loadSeatsState, saveSeatsState } = require('./src/seats-run');
  const { notifySeatsAero, sendAlert } = require('./src/notifier');
  const log = msg => console.log(`[seats] ${msg}`);

  log(`=== Scan ${new Date().toISOString()} ===`);
  const state = loadSeatsState();
  const result = await runSeatsCycle({
    force: process.argv.includes('--force'),
    routes: loadRoutes(),
    usesSource,
    minDate: minBookableDate(),
    state,
    saveState: saveSeatsState,
    notify: notifySeatsAero,
    sendAlert,
    log,
  });
  if (result.skipped) log(`Skipped: ${result.skipped}`);
  else log(`Done: ${result.calls} call(s), ${result.alerts} alert(s)${result.errors.length ? `, errors: ${result.errors.join('; ')}` : ''}`);
}

main().catch(e => { console.error('[seats] Fatal:', e); process.exitCode = 1; });
