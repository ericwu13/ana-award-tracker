/**
 * Discord front end for the chat agent (src/agent.js).
 *
 * The bot answers when it is @mentioned in the server (which includes replying
 * to one of its messages with the ping left on) or sent a DM — and never
 * otherwise, so the alert channel stays as quiet as before. Discord delivers
 * message text for mentions and DMs without the privileged Message Content
 * intent, so no change is needed in the developer portal.
 *
 * Only the owner may use it: AGENT_USER_IDS (comma-separated Discord user ids)
 * if set, otherwise the owner of DISCORD_GUILD_ID. Everyone else is ignored
 * silently — the agent can change the watch list and spends API credit.
 */
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');

const BUTTON_PREFIX = 'anachat';
const DISCORD_LIMIT = 2000;

/** Remove the bot's own mention(s) from a message, leaving what the user actually said. */
function stripBotMention(content, botId) {
  return String(content || '').replace(new RegExp(`<@!?${botId}>`, 'g'), ' ').replace(/\s+/g, ' ').trim();
}

/** Split text into chunks Discord will accept, breaking at line ends where possible. */
function splitForDiscord(text, max = DISCORD_LIMIT - 100) {
  const chunks = [];
  let rest = String(text);
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max);
    if (cut < max * 0.5) cut = max;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/**
 * One-line text of a message the user replied to (an alert embed or a plain
 * bot message), so "untrack this" has something to refer to.
 */
function describeMessage(msg) {
  const parts = [];
  if (msg.content) parts.push(msg.content);
  for (const embed of msg.embeds || []) {
    if (embed.title) parts.push(embed.title);
    for (const f of embed.fields || []) parts.push(`${f.name}: ${f.value}`);
  }
  return parts.join(' | ').replace(/\s+/g, ' ').slice(0, 800);
}

/** The set of Discord user ids from AGENT_USER_IDS, or null when it is unset. */
function parseAllowedUsers(raw) {
  const ids = String(raw || '').split(',').map(s => s.trim()).filter(s => /^\d{5,25}$/.test(s));
  return ids.length ? new Set(ids) : null;
}

function confirmationRows(confirmations) {
  return confirmations.slice(0, 4).map(c => new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${BUTTON_PREFIX}:yes:${c.id}`)
      .setLabel(`Confirm: ${c.summary}`.slice(0, 80))
      .setStyle(c.kind === 'untrack' ? ButtonStyle.Danger : ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`${BUTTON_PREFIX}:no:${c.id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  ));
}

/**
 * Wire the agent to a discord.js client.
 * @returns {{ handleButton: (interaction) => Promise<boolean> }} handleButton returns true if the interaction was ours
 */
function attachChat(client, agent, { env = process.env } = {}) {
  const configuredUsers = parseAllowedUsers(env.AGENT_USER_IDS);
  let ownerId = null;

  async function isAllowed(userId) {
    if (configuredUsers) return configuredUsers.has(userId);
    if (!ownerId && env.DISCORD_GUILD_ID) {
      try { ownerId = (await client.guilds.fetch(env.DISCORD_GUILD_ID)).ownerId; }
      catch (e) { console.error('[Chat] Could not look up the server owner:', e.message); }
    }
    return !!ownerId && userId === ownerId;
  }

  client.on('messageCreate', async (message) => {
    try {
      if (message.author.bot || !client.user) return;
      const isDM = !message.guildId;
      if (!isDM && !message.mentions.users.has(client.user.id)) return;
      if (!(await isAllowed(message.author.id))) {
        console.log(`[Chat] Ignored message from non-owner ${message.author.id}`);
        return;
      }

      const text = stripBotMention(message.content, client.user.id);
      let replyContext = null;
      if (message.reference && message.reference.messageId) {
        try {
          const ref = await message.fetchReference();
          if (ref.author.id === client.user.id) replyContext = describeMessage(ref) || null;
        } catch { /* the referenced message is gone — carry on without it */ }
      }
      if (!text && !replyContext) return;

      await message.channel.sendTyping().catch(() => {});
      const typing = setInterval(() => message.channel.sendTyping().catch(() => {}), 8000);
      let result;
      try {
        result = await agent.handle({
          text: text || '(no text — see the message being replied to)',
          conversationId: isDM ? `dm:${message.author.id}` : `ch:${message.channelId}:${message.author.id}`,
          userId: message.author.id,
          replyContext,
        });
      } finally {
        clearInterval(typing);
      }

      const chunks = splitForDiscord(result.text);
      const rows = confirmationRows(result.confirmations);
      for (let i = 0; i < chunks.length; i++) {
        const last = i === chunks.length - 1;
        const payload = { content: chunks[i], components: last ? rows : [], allowedMentions: { parse: [], repliedUser: false } };
        if (i === 0) await message.reply(payload);
        else await message.channel.send(payload);
      }
    } catch (err) {
      console.error('[Chat] Failed to answer a message:', err);
      await message.reply({ content: 'Something went wrong answering that. The slash commands still work.', allowedMentions: { parse: [], repliedUser: false } }).catch(() => {});
    }
  });

  async function handleButton(interaction) {
    const [prefix, answer, id] = String(interaction.customId || '').split(':');
    if (prefix !== BUTTON_PREFIX) return false;
    if (!(await isAllowed(interaction.user.id))) {
      await interaction.reply({ content: 'This is not yours to confirm.', flags: MessageFlags.Ephemeral });
      return true;
    }
    const outcome = agent.resolveConfirmation(id, interaction.user.id, answer === 'yes');
    // Keep any other pending confirmations on the message; drop the row just answered.
    const remaining = interaction.message.components.filter(row => !row.components.some(c => String(c.customId).endsWith(`:${id}`)));
    const content = `${interaction.message.content}\n\n${outcome.text}`.slice(0, DISCORD_LIMIT);
    await interaction.update({ content, components: remaining });
    return true;
  }

  console.log(agent.configured
    ? `[Chat] Chat agent ready (${agent.model}) — mention me or DM me`
    : '[Chat] Chat agent not configured — set GEMINI_API_KEY in .env to enable it');
  return { handleButton };
}

module.exports = { attachChat, stripBotMention, splitForDiscord, describeMessage, parseAllowedUsers, confirmationRows, BUTTON_PREFIX };
