/**
 * Discord slash command registration and handling.
 */
const { REST, Routes, SlashCommandBuilder } = require('discord.js');
const { addRoute, removeRoute, parseDateInput, formatStatus, formatRoutes, formatFlights, loadRoutes, saveRoutes } = require('./routes');

/**
 * Define slash commands.
 */
const commands = [
  new SlashCommandBuilder()
    .setName('track')
    .setDescription('Add a route and date to track for award availability')
    .addStringOption(opt => opt.setName('from').setDescription('Departure airport code (e.g., TPE, SFO, NRT)').setRequired(true))
    .addStringOption(opt => opt.setName('to').setDescription('Arrival airport code (e.g., SFO, TPE, LAX)').setRequired(true))
    .addStringOption(opt => opt.setName('date').setDescription('YYYY-MM-DD for a date, YYYY-MM for whole month (e.g., 2026-10-15 or 2026-10)').setRequired(true))
    .addStringOption(opt => opt.setName('cabin').setDescription('Cabin class to track (default: both)').setRequired(false).addChoices(
      { name: 'Economy only', value: 'economy' },
      { name: 'Business only', value: 'business' },
      { name: 'Both', value: 'both' },
    )),

  new SlashCommandBuilder()
    .setName('untrack')
    .setDescription('Remove a route or date from tracking')
    .addStringOption(opt => opt.setName('from').setDescription('Departure airport code (e.g., TPE)').setRequired(true))
    .addStringOption(opt => opt.setName('to').setDescription('Arrival airport code (e.g., SFO)').setRequired(true))
    .addStringOption(opt => opt.setName('date').setDescription('YYYY-MM-DD or YYYY-MM to remove (omit to remove entire route)').setRequired(false)),

  new SlashCommandBuilder()
    .setName('routes')
    .setDescription('List all tracked routes and dates'),

  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show current availability status for all tracked flights'),

  new SlashCommandBuilder()
    .setName('flights')
    .setDescription('Show detailed flight info for a route, class, and date')
    .addStringOption(opt => opt.setName('from').setDescription('Departure airport code (e.g., SFO)').setRequired(true))
    .addStringOption(opt => opt.setName('to').setDescription('Arrival airport code (e.g., TPE)').setRequired(true))
    .addStringOption(opt => opt.setName('class').setDescription('Cabin class').setRequired(true).addChoices(
      { name: 'Economy', value: 'Economy' },
      { name: 'Business', value: 'Business' },
    ))
    .addStringOption(opt => opt.setName('date').setDescription('YYYY-MM-DD or YYYY-MM (e.g., 2026-12 or 2026-12-04)').setRequired(true)),

  new SlashCommandBuilder()
    .setName('check')
    .setDescription('Trigger an immediate search now'),

  new SlashCommandBuilder()
    .setName('alerts')
    .setDescription('Manage alert history')
    .addStringOption(opt => opt.setName('action').setDescription('Action to perform').addChoices(
      { name: 'clear', value: 'clear' },
    ).setRequired(false)),
];

/**
 * Register slash commands with Discord.
 */
async function registerCommands(clientId, token) {
  const rest = new REST({ version: '10' }).setToken(token);
  const guildId = process.env.DISCORD_GUILD_ID;

  try {
    if (guildId) {
      // Guild commands — instant update
      console.log('[Discord] Registering guild slash commands...');
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
        body: commands.map(c => c.toJSON()),
      });
      console.log('[Discord] Guild slash commands registered (instant)');
    } else {
      // Global commands — takes up to 1 hour to propagate
      console.log('[Discord] Registering global slash commands (may take up to 1h)...');
      await rest.put(Routes.applicationCommands(clientId), {
        body: commands.map(c => c.toJSON()),
      });
      console.log('[Discord] Global slash commands registered');
    }
  } catch (err) {
    console.error('[Discord] Failed to register commands:', err.message);
  }
}

/**
 * Handle a slash command interaction.
 * @param {Interaction} interaction
 * @param {Function} triggerCheck - callback to trigger an immediate search
 */
async function handleCommand(interaction, triggerCheck) {
  const { commandName } = interaction;

  if (commandName === 'track') {
    const from = interaction.options.getString('from').toUpperCase();
    const to = interaction.options.getString('to').toUpperCase();
    const dateInput = interaction.options.getString('date');

    const cabin = interaction.options.getString('cabin') || 'both';

    const dates = parseDateInput(dateInput);
    if (!dates) {
      await interaction.reply(`❌ Invalid date format: \`${dateInput}\`\nUse \`YYYY-MM-DD\` for a specific date (e.g., \`2026-10-15\`) or \`YYYY-MM\` for a whole month (e.g., \`2026-10\`).`);
      return;
    }

    const { addedDates, totalDates } = addRoute(from, to, dates, cabin);
    const datesStr = dates.map(d => `\`${d}\``).join(', ');

    const cabinLabel = cabin === 'both' ? 'Economy+Business' : cabin.charAt(0).toUpperCase() + cabin.slice(1);
    if (addedDates.length === 0) {
      await interaction.reply(`Already tracking ${from}→${to} (${cabinLabel}) on those dates. (${totalDates} dates total)`);
    } else {
      await interaction.reply(`✅ Added **${from}→${to}** (${cabinLabel}) for ${datesStr}\n${addedDates.length} new date(s), ${totalDates} total.`);
    }
  }

  else if (commandName === 'untrack') {
    const from = interaction.options.getString('from').toUpperCase();
    const to = interaction.options.getString('to').toUpperCase();
    const dateInput = interaction.options.getString('date');

    let dates = null;
    if (dateInput) {
      dates = parseDateInput(dateInput);
      if (!dates) {
        await interaction.reply(`❌ Invalid date format: \`${dateInput}\``);
        return;
      }
    }

    const { removed, remainingDates } = removeRoute(from, to, dates);
    if (!removed) {
      await interaction.reply(`❌ Route ${from}→${to} not found.`);
    } else {
      // Clean cached flight data for removed dates
      const fs = require('fs');
      const path = require('path');
      const stateFile = path.join(__dirname, '..', 'data', 'state.json');
      try {
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        const routeLabel = `${from}→${to}`;
        let cleaned = 0;
        for (const key of Object.keys(state.flights || {})) {
          const shouldDelete = dates
            ? dates.some(d => key.startsWith(`${routeLabel}|${d}|`))
            : key.startsWith(`${routeLabel}|`);
          if (shouldDelete) { delete state.flights[key]; cleaned++; }
        }
        if (cleaned > 0) fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
        const cleanedMsg = cleaned > 0 ? ` Cleared ${cleaned} cached flights.` : '';
        if (!dates) {
          await interaction.reply(`✅ Removed entire route **${from}→${to}**.${cleanedMsg}`);
        } else {
          await interaction.reply(`✅ Removed dates from **${from}→${to}**. ${remainingDates} dates remaining.${cleanedMsg}`);
        }
      } catch {
        await interaction.reply(!dates
          ? `✅ Removed entire route **${from}→${to}**.`
          : `✅ Removed dates from **${from}→${to}**. ${remainingDates} dates remaining.`);
      }
    }
  }

  else if (commandName === 'routes') {
    const msg = formatRoutes();
    await interaction.reply(msg);
  }

  else if (commandName === 'status') {
    const msg = formatStatus();
    // Discord has a 2000 char limit — split if needed
    if (msg.length > 1900) {
      await interaction.reply(msg.substring(0, 1900) + '\n...(truncated)');
    } else {
      await interaction.reply(msg);
    }
  }

  else if (commandName === 'flights') {
    const from = interaction.options.getString('from').toUpperCase();
    const to = interaction.options.getString('to').toUpperCase();
    const cabin = interaction.options.getString('class');
    const dateInput = interaction.options.getString('date');

    const msg = formatFlights(from, to, dateInput, cabin);
    if (msg.length > 1900) {
      await interaction.reply(msg.substring(0, 1900) + '\n...(truncated)');
    } else {
      await interaction.reply(msg);
    }
  }

  else if (commandName === 'check') {
    await interaction.reply('🔍 Triggering search now...');
    if (triggerCheck) triggerCheck();
  }

  else if (commandName === 'alerts') {
    const action = interaction.options.getString('action');
    if (action === 'clear') {
      const fs = require('fs');
      const path = require('path');
      const stateFile = path.join(__dirname, '..', 'data', 'state.json');
      try {
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        const count = Object.keys(state.flights || {}).length;
        state.flights = {};
        fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
        await interaction.reply(`🗑️ Cleared ${count} tracked flights. All availability will be re-alerted on next check.`);
      } catch {
        await interaction.reply('❌ Could not clear alerts (state file issue).');
      }
    } else {
      // Show alert summary
      const { totalFlights, summary } = require('./routes').getStatusSummary();
      await interaction.reply(`📊 Tracking ${totalFlights} flights. Use \`/status\` for details or \`/alerts clear\` to reset.`);
    }
  }
}

module.exports = { commands, registerCommands, handleCommand };
