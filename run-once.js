/**
 * Single-run scraper — runs one check cycle and exits.
 * Designed to be called by Task Scheduler via run-check.vbs.
 * Cookie server runs in the persistent Discord bot process (discord-bot.js).
 */
require('dotenv').config();

// Load and run the main index
require('./src/index.js');
