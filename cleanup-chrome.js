#!/usr/bin/env node
/**
 * Manual cleanup of Chrome instances left behind by the bot.
 *
 *   node cleanup-chrome.js          # kill orphaned bot browsers only (safe while bot is running)
 *   node cleanup-chrome.js --all    # kill EVERY bot browser (use when nothing should be running)
 *   node cleanup-chrome.js --list   # just show what would be killed
 *
 * Only Chrome processes using a chrome-launcher `lighthouse.*` temp profile are
 * touched — your own Chrome is never affected.
 */
const { cleanupChrome, classifyChrome, listProcesses } = require('./src/chrome-cleanup');

const args = new Set(process.argv.slice(2));
const all = args.has('--all');

if (process.platform !== 'win32') {
  console.log('[ChromeCleanup] Windows only.');
  process.exit(0);
}

if (args.has('--list')) {
  const { kill, keep } = classifyChrome(listProcesses(), { all });
  console.log(`Would kill ${kill.length} process(es):`);
  for (const k of kill) console.log(`  pid ${k.pid}  ${k.reason.padEnd(8)}  ${k.profileDir}`);
  console.log(`Would keep ${keep.length} browser(s):`);
  for (const k of keep) console.log(`  pid ${k.pid}  ${k.profileDir}`);
  process.exit(0);
}

const result = cleanupChrome({ all });
console.log(`[ChromeCleanup] Done — killed ${result.killed}, kept ${result.kept}, removed ${result.sweptDirs} stale profile dir(s)`);
