/**
 * Notification module — sends alerts via Discord REST API.
 * Uses REST API (not gateway client) so it doesn't conflict with the
 * persistent Discord bot in discord-bot.js.
 */
const { REST, Routes } = require('discord.js');

let rest = null;

function getRestClient() {
  if (!rest) {
    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token) return null;
    rest = new REST({ version: '10' }).setToken(token);
  }
  return rest;
}

/**
 * Send a message to a Discord channel via REST API (no gateway needed).
 */
async function sendDiscord(channelId, content) {
  const client = getRestClient();
  if (!client || !channelId) return false;

  try {
    const body = typeof content === 'string'
      ? { content }
      : content; // { embeds: [...] }

    await client.post(Routes.channelMessages(channelId), { body });
    return true;
  } catch (err) {
    console.error('[Notifier] Discord REST send failed:', err.message);
    return false;
  }
}

/**
 * Send a status/alert message.
 */
async function sendAlert(message) {
  console.log(`[Notifier] Sending: ${message.substring(0, 100)}...`);
  const channelId = process.env.DISCORD_STATUS_CHANNEL_ID;
  const sent = await sendDiscord(channelId, message);
  if (sent) console.log('[Notifier] Discord alert sent');
  else console.error('[Notifier] Failed to send alert');
  return sent;
}

/**
 * Send a status update message.
 */
async function sendStatusUpdate(message) {
  const channelId = process.env.DISCORD_STATUS_CHANNEL_ID;
  return sendDiscord(channelId, message);
}

/**
 * Send a rich availability alert.
 */
async function notifyAvailability(date, result, routeLabel) {
  const cabin = result.cabin || 'Unknown';
  const isWaitlist = result.waitlist && !result.confirmed;
  const status = isWaitlist ? '⏳ WAITLIST' : '✅ CONFIRMED';
  const symbol = result.symbol || '?';

  // Route info
  let routeInfo = routeLabel || 'TPE → SFO';
  if (result.routeDesc) {
    routeInfo = result.routeDesc;
  } else if (result.layover === true && result.stops && result.stops.length > 0) {
    const [from, to] = (routeLabel || 'TPE→SFO').split('→').map(s => s.trim());
    routeInfo = `${from} → ${result.stops.join(' → ')} → ${to}`;
  }
  const routeType = result.layover === true ? '🔄 Layover' : result.layover === false ? '✈️ Direct' : '✈️';

  // Cabin detail per leg
  let cabinDetail = `${cabin} class`;
  if (result.isMixedCabin && result.cabinDesc) {
    cabinDetail = `⚠️ MIXED: ${result.cabinDesc}`;
  } else if (result.cabinDesc) {
    cabinDetail = result.cabinDesc;
  }

  let timeInfo = 'TBD';
  if (result.depTime && result.arrTime) {
    timeInfo = `${result.depTime} → ${result.arrTime}`;
    if (result.duration) timeInfo += ` (${result.duration})`;
  }

  const flightNum = result.flightNumber || 'N/A';
  const statusChange = result._statusChange || '';

  const alertChannelId = process.env.DISCORD_ALERT_CHANNEL_ID;
  const color = result.isMixedCabin ? 0xFF6600 : isWaitlist ? 0xFFA500 : 0x00FF00;
  const title = statusChange ? `🎫 ANA Award — ${statusChange}` : '🎫 ANA Award Seat Found!';

  const embed = {
    title,
    color,
    fields: [
      { name: 'Status', value: `${status} ${symbol}`, inline: true },
      { name: 'Date', value: date, inline: true },
      { name: 'Class', value: cabinDetail, inline: false },
      { name: 'Route', value: `${routeInfo} ${routeType}`, inline: false },
      { name: 'Flight', value: flightNum, inline: true },
      { name: 'Times', value: timeInfo, inline: true },
    ],
    footer: {
      text: result.isMixedCabin ? 'Mixed cabin — not all legs match searched class'
        : isWaitlist ? 'Waitlist only — not guaranteed'
        : 'Seats available! Book now!'
    },
    timestamp: new Date().toISOString(),
  };

  const sent = await sendDiscord(alertChannelId, { embeds: [embed] });
  if (sent) console.log('[Notifier] Discord embed alert sent');
  return sent;
}

// No-op functions for backward compatibility (index.js may call these)
async function initDiscord() { return true; }
async function destroyDiscord() {}

module.exports = { initDiscord, destroyDiscord, sendAlert, notifyAvailability, sendStatusUpdate };
