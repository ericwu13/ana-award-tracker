/**
 * Persistent Discord bot for slash commands.
 * Runs independently from the search process.
 * Start with: node discord-bot.js (or via Task Scheduler)
 */
require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { registerCommands, handleCommand } = require('./src/discord-commands');
const { seedRoutesIfNeeded } = require('./src/routes');
const { startCookieServer } = require('./src/cookie-server');
const { execSync, spawn } = require('child_process');

// Seed routes from .env if first run
seedRoutesIfNeeded();

// Start cookie server so Chrome extension can push cookies
startCookieServer();

const token = process.env.DISCORD_BOT_TOKEN;
if (!token) {
  console.error('[Discord] No DISCORD_BOT_TOKEN in .env');
  process.exit(1);
}

let isCheckRunning = false;

/** Trigger an immediate search by running run-once.js */
function triggerCheck() {
  if (isCheckRunning) {
    console.log('[Discord] Check already running, skipping');
    return;
  }
  isCheckRunning = true;
  console.log('[Discord] Triggering immediate check...');

  const child = spawn('node', ['run-once.js'], {
    cwd: __dirname,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
    windowsHide: true,
  });

  child.stdout.on('data', d => process.stdout.write(d));
  child.stderr.on('data', d => process.stderr.write(d));

  child.on('exit', (code) => {
    isCheckRunning = false;
    console.log(`[Discord] Check finished (exit ${code})`);
  });

  child.on('error', (err) => {
    isCheckRunning = false;
    console.error('[Discord] Check failed to start:', err.message);
  });
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
  console.log(`[Discord] Bot ready: ${client.user.tag}`);
  await registerCommands(client.user.id, token);
  console.log('[Discord] Listening for slash commands...');
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
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log('\n[Discord] Shutting down...');
  client.destroy();
  process.exit(0);
});

console.log('[Discord] Starting persistent Discord bot...');
