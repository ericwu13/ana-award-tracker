#!/usr/bin/env node
/**
 * Manual cleanup of Chrome instances left behind by the bot.
 *
 *   node cleanup-chrome.js          # kill orphaned bot browsers only (safe while bot is running)
 *   node cleanup-chrome.js --all    # kill EVERY bot browser (use when nothing should be running)
 *   node cleanup-chrome.js --list   # just show what would be killed
 *
 * Only Chrome processes using a chrome-launcher `%TEMP%\lighthouse.*` profile are
 * touched — your own Chrome is never affected.
 */
const os = require('os');
const { cleanupChrome, classifyChrome, listProcesses } = require('./src/chrome-cleanup');

const args = new Set(process.argv.slice(2));
const all = args.has('--all');

(async () => {
  if (process.platform !== 'win32') {
    console.log('[ChromeCleanup] Windows only.');
    return;
  }

  if (args.has('--list')) {
    const procs = await listProcesses();
    if (!procs) {
      console.error('[ChromeCleanup] Could not list processes (PowerShell/WMI failed).');
      process.exitCode = 1;
      return;
    }
    const { kill, keep } = classifyChrome(procs, { all, tmpDir: os.tmpdir() });
    console.log(`TEMP: ${os.tmpdir()}`);
    console.log(`Would kill ${kill.length} process(es):`);
    for (const k of kill) console.log(`  pid ${String(k.pid).padEnd(6)} ${k.reason.padEnd(17)} ${k.profileDir}`);
    console.log(`Would keep ${keep.length} browser(s):`);
    for (const k of keep) console.log(`  pid ${String(k.pid).padEnd(6)} ${k.profileDir}`);
    return;
  }

  const r = await cleanupChrome({ all });
  if (!r.ok) { process.exitCode = 1; return; }
  console.log(`[ChromeCleanup] Done — killed ${r.killed}, kept ${r.kept}, removed ${r.sweptDirs} stale profile dir(s)`);
})();
