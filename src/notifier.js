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

  // Route info — always use the search route label as the primary direction,
  // add stops from the parsed data if available
  const [searchFrom, searchTo] = (routeLabel || 'TPE→SFO').split('→').map(s => s.trim());
  let routeInfo = `${searchFrom} → ${searchTo}`;
  if (result.stops && result.stops.length > 0) {
    routeInfo = `${searchFrom} → ${result.stops.join(' → ')} → ${searchTo}`;
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

  // Miles + tax/fee co-pay. ANA award tickets require both miles and a cash
  // payment for taxes/fees — show them together so the user sees the full cost.
  // The parser may be unable to extract miles for some flights (e.g., if ANA
  // changes their JS call signature), in which case show "Unknown".
  let costValue;
  if (result.miles) {
    costValue = `${result.miles.toLocaleString()} miles`;
    if (result.taxUsd != null) {
      costValue += ` + $${result.taxUsd.toFixed(2)}`;
    }
  } else {
    costValue = 'Unknown';
  }

  const alertChannelId = process.env.DISCORD_ALERT_CHANNEL_ID;
  const color = result.isMixedCabin ? 0xFF6600 : isWaitlist ? 0xFFA500 : 0x00FF00;
  const title = statusChange ? `🎫 ANA Award — ${statusChange}` : '🎫 ANA Award Seat Found!';

  const embed = {
    title,
    color,
    fields: [
      { name: 'Status', value: `${status} ${symbol}`, inline: true },
      { name: 'Date', value: date, inline: true },
      { name: 'Cost', value: costValue, inline: true },
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


const CABIN_LABEL = { 'economy': 'Economy', 'premium-economy': 'Premium Economy', 'business': 'Business', 'first': 'First' };

/** Human name for a seats.aero program id (unknown ids pass through). */
const PROGRAM_LABEL = {
  aeroplan: 'Aeroplan', united: 'United MileagePlus', lifemiles: 'LifeMiles', singapore: 'KrisFlyer',
  turkish: 'Turkish Miles&Smiles', lufthansa: 'Miles & More', ethiopian: 'ShebaMiles', eurobonus: 'SAS EuroBonus',
  copa: 'Copa ConnectMiles', virginatlantic: 'Virgin Atlantic', flyingblue: 'Flying Blue', alaska: 'Alaska Mileage Plan',
  american: 'AAdvantage', delta: 'Delta SkyMiles', qantas: 'Qantas', velocity: 'Velocity', emirates: 'Emirates Skywards',
  etihad: 'Etihad Guest', qatar: 'Qatar Privilege Club', jetblue: 'JetBlue TrueBlue', finnair: 'Finnair Plus',
  smiles: 'Smiles', azul: 'Azul', aeromexico: 'Aeromexico', saudia: 'Saudia AlFursan',
};

/**
 * Pure: build the Discord embed for one seats.aero alert group
 * (one route + date + cabin, every qualifying program, cheapest first).
 */
function buildSeatsAeroEmbed(group) {
  const [from, to] = group.route.split('→');
  const lines = group.items.map(({ entry: e, reason, previousMiles }) => {
    const name = PROGRAM_LABEL[e.program] || e.program;
    let cost = `${e.miles.toLocaleString('en-US')} mi`;
    if (Number.isFinite(e.taxes) && (!e.taxesCurrency || e.taxesCurrency === 'USD')) cost += ` + $${(e.taxes / 100).toFixed(2)}`;
    const bits = [];
    if (e.airlines && e.airlines.length) bits.push(e.airlines.join('/'));
    if (e.direct === true) bits.push('direct'); else if (e.direct === false) bits.push('connecting');
    if (e.seats) bits.push(`${e.seats} seat${e.seats > 1 ? 's' : ''}`);
    const tag = reason === 'price-drop' && previousMiles ? ` ⬇️ was ${previousMiles.toLocaleString('en-US')}` : '';
    return `**${name}** — ${cost}${bits.length ? ` · ${bits.join(' · ')}` : ''}${tag}`;
  });
  const anyDrop = group.items.some(i => i.reason === 'price-drop');
  return {
    title: `💺 ${CABIN_LABEL[group.cabinKey] || group.cabinKey} saver — ${from} → ${to}`,
    color: anyDrop ? 0x3399FF : 0x00B0F4,
    description: lines.join('\n'),
    fields: [
      { name: 'Date', value: group.date, inline: true },
      { name: 'Source', value: 'seats.aero (cached)', inline: true },
    ],
    footer: { text: 'Book with the listed program. Cached data: check the airline site before moving points.' },
    timestamp: new Date().toISOString(),
  };
}

/** Send one seats.aero alert group to the alert channel (same channel as ANA). */
async function notifySeatsAero(group) {
  const sent = await sendDiscord(process.env.DISCORD_ALERT_CHANNEL_ID, { embeds: [buildSeatsAeroEmbed(group)] });
  if (sent) console.log(`[Notifier] seats.aero alert sent: ${group.route} ${group.date} ${group.cabinKey}`);
  return sent;
}

// No-op functions for backward compatibility (index.js may call these)
async function initDiscord() { return true; }
async function destroyDiscord() {}

module.exports = { initDiscord, destroyDiscord, sendAlert, notifyAvailability, sendStatusUpdate, notifySeatsAero, buildSeatsAeroEmbed };
