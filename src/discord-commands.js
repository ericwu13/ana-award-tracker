/**
 * Discord slash command registration and handling.
 */
const { REST, Routes, SlashCommandBuilder } = require('discord.js');
const { addRoute, removeRoute, syncState, parseDateInput, expandDateRange, formatStatus, formatRoutes, formatFlights, loadRoutes, saveRoutes } = require('./routes');

/**
 * Define slash commands.
 */
const commands = [
  new SlashCommandBuilder()
    .setName('track')
    .setDescription('Add a route and date to track for award availability')
    .addStringOption(opt => opt.setName('from').setDescription('Departure airport code (e.g., TPE, SFO, NRT)').setRequired(true))
    .addStringOption(opt => opt.setName('to').setDescription('Arrival airport code (e.g., SFO, TPE, LAX)').setRequired(true))
    .addStringOption(opt => opt.setName('date').setDescription('Start date (YYYY-MM-DD) or month (YYYY-MM)').setRequired(true))
    .addStringOption(opt => opt.setName('until').setDescription('End date for range (YYYY-MM-DD) — adds every day from date to until').setRequired(false))
    .addStringOption(opt => opt.setName('cabin').setDescription('Cabin class to track (default: Premium Eco + Business)').setRequired(false).addChoices(
      { name: 'Premium Eco + Business (default)', value: 'both' },
      { name: 'All three (PE + Economy + Business)', value: 'all' },
      { name: 'Economy only', value: 'economy' },
      { name: 'Business only', value: 'business' },
      { name: 'Premium Economy only', value: 'premium-economy' },
    )),

  new SlashCommandBuilder()
    .setName('untrack')
    .setDescription('Remove a route, date, or just a specific cabin from a date')
    .addStringOption(opt => opt.setName('from').setDescription('Departure airport code (e.g., TPE)').setRequired(true))
    .addStringOption(opt => opt.setName('to').setDescription('Arrival airport code (e.g., SFO)').setRequired(true))
    .addStringOption(opt => opt.setName('date').setDescription('YYYY-MM-DD or YYYY-MM (omit to remove entire route)').setRequired(false))
    .addStringOption(opt => opt.setName('until').setDescription('End date for range (YYYY-MM-DD) — removes every day from date to until').setRequired(false))
    .addStringOption(opt => opt.setName('cabin').setDescription('Optional: remove only this cabin from the date(s)').setRequired(false).addChoices(
      { name: 'Premium Economy', value: 'premium-economy' },
      { name: 'Economy', value: 'economy' },
      { name: 'Business', value: 'business' },
    )),

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
      { name: 'Premium Economy', value: 'Premium Economy' },
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

  new SlashCommandBuilder()
    .setName('sync')
    .setDescription('Remove stale flight data for routes/dates no longer tracked'),
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
    const untilInput = interaction.options.getString('until');

    const cabin = interaction.options.getString('cabin') || 'both';

    let dates;
    if (untilInput) {
      // Range mode: date → until (daily)
      dates = expandDateRange(dateInput.trim(), untilInput.trim());
      if (!dates) {
        await interaction.reply(`❌ Invalid date range: \`${dateInput}\` to \`${untilInput}\``);
        return;
      }
    } else {
      dates = parseDateInput(dateInput);
      if (!dates) {
        await interaction.reply(`❌ Invalid date format: \`${dateInput}\`\nUse \`YYYY-MM-DD\` for a date, \`YYYY-MM\` for a month, or add \`until:\` for a range.`);
        return;
      }
    }

    const { newlyAddedDates, updatedDates, totalDates } = addRoute(from, to, dates, cabin);

    const cabinLabels = {
      'both': 'Premium Eco+Business',
      'all': 'PE+Economy+Business',
      'economy': 'Economy',
      'business': 'Business',
      'premium-economy': 'Premium Economy',
    };
    const cabinLabel = cabinLabels[cabin] || 'Premium Eco+Business';

    if (newlyAddedDates.length === 0 && updatedDates.length === 0) {
      await interaction.reply(`ℹ️ Already tracking **${from}→${to}** with those cabins on those dates. (${totalDates} dates total)`);
    } else {
      const lines = [`✅ Updated **${from}→${to}**:`];
      if (newlyAddedDates.length > 0) {
        const dateStr = newlyAddedDates.slice().sort().map(d => `\`${d}\``).join(', ');
        lines.push(`  • Added ${newlyAddedDates.length} new date(s) with ${cabinLabel}: ${dateStr}`);
      }
      if (updatedDates.length > 0) {
        const dateStr = updatedDates.slice().sort().map(d => `\`${d}\``).join(', ');
        lines.push(`  • Added ${cabinLabel} cabin(s) to ${updatedDates.length} existing date(s): ${dateStr}`);
      }
      lines.push(`${totalDates} dates total.`);
      await interaction.reply(lines.join('\n'));
    }
  }

  else if (commandName === 'untrack') {
    const from = interaction.options.getString('from').toUpperCase();
    const to = interaction.options.getString('to').toUpperCase();
    const dateInput = interaction.options.getString('date');
    const untilInput = interaction.options.getString('until');
    const cabin = interaction.options.getString('cabin'); // optional

    let dates = null;
    if (untilInput && dateInput) {
      // Range mode: date → until (daily)
      dates = expandDateRange(dateInput.trim(), untilInput.trim());
      if (!dates) {
        await interaction.reply(`❌ Invalid date range: \`${dateInput}\` to \`${untilInput}\``);
        return;
      }
    } else if (dateInput) {
      const trimmed = dateInput.trim();
      if (/^\d{4}-\d{2}$/.test(trimmed)) {
        // Month input (YYYY-MM): find ALL dates in this route that fall in that
        // month, not just the parseDateInput weekly expansion. This handles the
        // case where dates were added individually (12-02, 12-03, etc.) but the
        // user untracks by month — they expect ALL December dates removed.
        const currentRoutes = loadRoutes();
        const route = currentRoutes.find(r => r.from === from && r.to === to);
        if (route && route.dates) {
          const monthDates = Object.keys(route.dates).filter(d => d.startsWith(trimmed));
          // Also include the parseDateInput expansion so dates not yet in the
          // route (edge case) are covered
          const expanded = parseDateInput(dateInput) || [];
          dates = [...new Set([...monthDates, ...expanded])];
        } else {
          dates = parseDateInput(dateInput);
        }
      } else {
        dates = parseDateInput(dateInput);
      }
      if (!dates) {
        await interaction.reply(`❌ Invalid date format: \`${dateInput}\``);
        return;
      }
    }

    const result = removeRoute(from, to, dates, cabin);
    if (!result.removed) {
      await interaction.reply(`❌ Route ${from}→${to} not found.`);
      return;
    }

    // Clean cached flight data + lastChecked entries for removed dates.
    // For month-based untrack (YYYY-MM), use prefix matching on state keys
    // instead of relying solely on result.removedDates — this catches orphaned
    // entries from prior buggy /untrack calls that removed routes but failed
    // to clean state (e.g., parseDateInput expansion mismatch).
    const fs = require('fs');
    const path = require('path');
    const stateFile = path.join(__dirname, '..', 'data', 'state.json');
    let cleaned = 0;
    const isMonthInput = dateInput && /^\d{4}-\d{2}$/.test(dateInput.trim());
    try {
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      const routeLabel = `${from}→${to}`;

      const shouldCleanKey = (key) => {
        if (!key.startsWith(`${routeLabel}|`)) return false;
        if (result.removedEntireRoute) return true;
        // Month-based full removal (no cabin filter): clean by month prefix
        // to catch orphaned daily entries that aren't in result.removedDates
        if (!cabin && isMonthInput) {
          const [, flightDate] = key.split('|');
          return flightDate && flightDate.startsWith(dateInput.trim());
        }
        // Specific dates: clean only those actually removed from routes
        return result.removedDates.some(d => key.startsWith(`${routeLabel}|${d}|`));
      };

      for (const key of Object.keys(state.flights || {})) {
        if (shouldCleanKey(key)) { delete state.flights[key]; cleaned++; }
      }
      // Also clean lastChecked for consistency
      for (const key of Object.keys(state.lastChecked || {})) {
        if (shouldCleanKey(key)) { delete state.lastChecked[key]; }
      }
      if (cleaned > 0) fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
    } catch {
      // state.json unreadable — proceed with just the route removal reply
    }

    const cleanedMsg = cleaned > 0 ? ` Cleared ${cleaned} cached flights.` : '';
    const cabinLabels = { 'premium-economy': 'Premium Economy', 'economy': 'Economy', 'business': 'Business' };
    const cabinLabel = cabin ? cabinLabels[cabin] || cabin : null;

    if (result.removedEntireRoute) {
      await interaction.reply(`✅ Removed entire route **${from}→${to}**.${cleanedMsg}`);
    } else if (cabinLabel && result.updatedDates.length > 0 && result.removedDates.length === 0) {
      await interaction.reply(`✅ Removed ${cabinLabel} from ${result.updatedDates.length} date(s) on **${from}→${to}**. ${result.remainingDates} dates remaining.${cleanedMsg}`);
    } else if (cabinLabel && result.removedDates.length > 0) {
      await interaction.reply(`✅ Removed ${cabinLabel} from ${result.updatedDates.length + result.removedDates.length} date(s); ${result.removedDates.length} date(s) became empty and were deleted. **${from}→${to}** has ${result.remainingDates} dates remaining.${cleanedMsg}`);
    } else if (result.removedDates.length > 0) {
      await interaction.reply(`✅ Removed ${result.removedDates.length} date(s) from **${from}→${to}**. ${result.remainingDates} dates remaining.${cleanedMsg}`);
    } else {
      await interaction.reply(`ℹ️ No matching ${cabinLabel || 'date'}(s) found on **${from}→${to}**. ${result.remainingDates} dates remaining.`);
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

  else if (commandName === 'sync') {
    const result = syncState();
    if (result.prunedFlights === 0 && result.prunedLastChecked === 0) {
      await interaction.reply(`✅ State is already in sync. ${result.remainingFlights} tracked flights match current routes.`);
    } else {
      const parts = [];
      if (result.prunedFlights > 0) parts.push(`${result.prunedFlights} stale flight(s)`);
      if (result.prunedLastChecked > 0) parts.push(`${result.prunedLastChecked} stale check record(s)`);
      await interaction.reply(`🧹 Synced! Removed ${parts.join(' + ')}. ${result.remainingFlights} flights remaining.`);
    }
  }
}

module.exports = { commands, registerCommands, handleCommand };
