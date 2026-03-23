const { spawn, execSync } = require('child_process');
require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { startCookieServer } = require('./src/cookie-server');
const { registerCommands, handleCommand } = require('./src/discord-commands');
const { seedRoutesIfNeeded } = require('./src/routes');

// Start the cookie receiver server — Chrome extension pushes fresh cookies here
startCookieServer();

// Seed routes.json from .env if first run
seedRoutesIfNeeded();

/** Kill orphaned Chrome processes spawned by puppeteer */
function cleanupChrome() {
  try {
    const out = execSync(
      'powershell -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'chrome.exe\'\\" | Where-Object { $_.CommandLine -match \'puppeteer\' } | Select-Object -ExpandProperty ProcessId"',
      { encoding: 'utf8', timeout: 10000, windowsHide: true }
    ).trim();
    if (out) {
      const pids = out.split(/\r?\n/).map(p => p.trim()).filter(Boolean);
      if (pids.length > 0) {
        console.log(`[Runner] Cleaning up ${pids.length} orphaned Chrome process(es)`);
        execSync(`powershell -Command "Stop-Process -Id ${pids.join(',')} -Force -ErrorAction SilentlyContinue"`, { timeout: 10000, windowsHide: true });
      }
    }
  } catch (e) {}
}

/**
 * Get delay until next check based on time of day.
 * - 6am-11pm PST: every 30 minutes
 * - 11pm-6am PST: every 2 hours
 */
function getNextCheckDelay() {
  const now = new Date();
  const pstHour = parseInt(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false }));

  const isDaytime = pstHour >= 6 && pstHour < 23;
  const intervalMs = isDaytime ? 30 * 60 * 1000 : 2 * 60 * 60 * 1000;

  const intervalMin = intervalMs / 60000;
  const minutesIntoHour = now.getMinutes();
  const nextBoundary = Math.ceil(minutesIntoHour / intervalMin) * intervalMin;
  let waitMinutes = nextBoundary - minutesIntoHour;
  if (waitMinutes < 2) waitMinutes += intervalMin;

  return waitMinutes * 60 * 1000;
}

let lastStartTime = 0;
let nextCheckTimer = null;
let isRunning = false;

function start() {
  if (isRunning) {
    console.log('[Runner] Check already running, skipping');
    return;
  }
  isRunning = true;
  lastStartTime = Date.now();
  const timeStr = new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit', hour12: true });
  console.log(`[Runner] Starting check at ${timeStr}`);

  const child = spawn('node', ['src/index.js'], {
    cwd: __dirname,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
    windowsHide: true,
  });

  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);

  child.on('exit', (code, signal) => {
    isRunning = false;
    const elapsed = Date.now() - lastStartTime;
    cleanupChrome();

    if (code === 2) {
      const backoffMs = 2 * 60 * 60 * 1000;
      const nextTime = new Date(Date.now() + backoffMs).toLocaleString('en-US', {
        timeZone: 'America/Los_Angeles',
        hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true,
      });
      console.log(`[Runner] ⛔ Rate-limited — backing off until ${nextTime}`);
      nextCheckTimer = setTimeout(start, backoffMs);
      return;
    }

    if (elapsed < 5000) {
      console.error(`[Runner] Bot crashed in ${elapsed}ms (code ${code}) — waiting 60s before retry`);
      nextCheckTimer = setTimeout(start, 60000);
      return;
    }

    const waitTime = getNextCheckDelay();
    const nextTime = new Date(Date.now() + waitTime).toLocaleString('en-US', {
      timeZone: 'America/Los_Angeles',
      hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true,
    });
    console.log(`[Runner] Check finished (${Math.round(elapsed / 1000)}s). Next check at ${nextTime} (in ${Math.round(waitTime / 1000)}s)`);
    nextCheckTimer = setTimeout(start, waitTime);
  });

  child.on('error', (err) => {
    isRunning = false;
    console.error(`[Runner] Failed to start:`, err.message);
    nextCheckTimer = setTimeout(start, 60000);
  });
}

/** Trigger an immediate check (from Discord /check command) */
function triggerCheck() {
  if (nextCheckTimer) clearTimeout(nextCheckTimer);
  start();
}

// === Discord Bot ===
const token = process.env.DISCORD_BOT_TOKEN;
if (token) {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once('ready', async () => {
    console.log(`[Discord] Bot ready: ${client.user.tag}`);
    await registerCommands(client.user.id, token);
  });

  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    try {
      await handleCommand(interaction, triggerCheck);
    } catch (err) {
      console.error('[Discord] Command error:', err.message);
      if (!interaction.replied) {
        await interaction.reply(`❌ Error: ${err.message}`).catch(() => {});
      }
    }
  });

  client.login(token).catch(err => {
    console.error('[Discord] Login failed:', err.message);
  });

  process.on('SIGINT', () => {
    console.log('\n[Runner] Shutting down...');
    client.destroy();
    process.exit(0);
  });
} else {
  console.log('[Runner] No DISCORD_BOT_TOKEN — Discord commands disabled');
  process.on('SIGINT', () => {
    console.log('\n[Runner] Shutting down...');
    process.exit(0);
  });
}

// Update index.js to read from routes.json
// Start the first check
start();
