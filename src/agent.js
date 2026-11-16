/**
 * Chat agent — lets the owner talk to the tracker in plain language.
 *
 * Gemini gets the tracker-api operations as function tools and decides which to
 * call; this module runs the request → tool → request loop over Google's
 * Interactions API (`@google/genai`, `client.interactions.create`). It knows
 * nothing about Discord: src/discord-chat.js feeds it text and renders what
 * comes back.
 *
 * Three things here are deliberate:
 *
 * - Confirmation is enforced in code, not left to the model. A big `track`
 *   (many new dates = more load on ANA) or a broad `untrack` is NOT executed by
 *   the tool: it is parked as a pending confirmation that the front end shows as
 *   a button, and only the user's click runs it.
 *
 * - Stateless on Google's side (`store: false`): the conversation lives in this
 *   process and is sent in full each time, so nothing is kept server-side.
 *
 * - That history is append-only and replayed exactly as returned. The API
 *   requires `thought` and `function_call` steps to come back unmodified (they
 *   carry signatures), so nothing is ever edited or trimmed: today's date and
 *   confirmation outcomes ride in the new user message, and a conversation that
 *   gets old or long is dropped whole.
 */
const { GoogleGenAI } = require('@google/genai');
const api = require('./tracker-api');
const { todayPST } = require('./routes');

// Google's fastest, lowest-cost current model. The job is tool routing over
// small, pre-digested results, which it handles; it is NOT trusted to convert
// time zones or condense long raw lists, so tool output is shaped for it
// (see localizeTimes below and tracker-api.describeTracked). A larger model
// can be set with AGENT_MODEL.
const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
const MAX_MODEL_CALLS_PER_TURN = 8;
const REQUEST_OPTIONS = { maxRetries: 2, timeout: 120000 };

const CONVERSATION_TTL_MS = 30 * 60 * 1000;
const CONVERSATION_MAX_STEPS = 120;
const CONFIRMATION_TTL_MS = 10 * 60 * 1000;
// Above these, a change waits for the user's click.
const TRACK_CONFIRM_ABOVE_NEW_DATES = 14;
const UNTRACK_CONFIRM_ABOVE_DATES = 3;

const SETUP_HINT = 'Chat is not set up yet: add `GEMINI_API_KEY=...` to `.env` and restart the Discord bot. Slash commands still work.';

const SYSTEM_PROMPT = `You are the chat front end of a personal ANA (All Nippon Airways) award-seat tracker, talking with its owner in Discord. A bot on their PC searches ANA's award site about once an hour for the routes, dates and cabins on a watch list, and posts an alert in this Discord server when seats appear. Your tools read that bot's data and change its watch list. You cannot search ANA yourself and you cannot book anything.

How the tracker works, so your answers are accurate:
- The watch list is per route (from→to), per date, per cabin: economy, premium-economy, business. Airports are 3-letter IATA codes; ANA also accepts city codes such as TYO (Tokyo: HND and NRT). Each direction is its own route, so a round trip is two routes.
- Seat data comes from the most recent search of each date, so it can be a few hours old; the status tool says when the last check ran. Times in tool results are already in US Pacific time with their age; repeat them as given. A newly tracked date has no data until the next check. Starting a check on demand takes about 40 minutes; the hourly run would pick it up anyway.
- "confirmed" seats can be booked now; "waitlist" seats cannot. Talk about confirmed seats unless the user asks about waitlist.
- Miles are one-way per person for the whole itinerary; taxUsd is the cash co-pay on top.
- ANA stops booking award seats 96 hours before departure, and the tracker drops dates inside that window.
- Tracking a month given as YYYY-MM samples one date per week. To cover every day, give a start date and an end date.

Working with the user:
- Each message starts with a bracketed context line giving today's date. Resolve relative dates ("next Friday", "Dec 10-15") against it, and when no year is given assume the next future occurrence.
- When a request is clear, do it and say what changed. Ask a question only when you can't tell the route, the dates, or which of several plausible meanings is intended. If the user doesn't name a cabin when tracking, use the default (premium economy + business) and say that you did.
- Large or destructive changes are held for the user: instead of making the change, the tool reports that a Confirm button was shown. Say what is waiting for their confirmation; don't describe it as done and don't try it again.
- Only state availability, prices and tracker state that a tool returned in this conversation. If the data doesn't answer the question, say what is missing.
- When the user replies to one of the bot's alert messages, that alert's text is included in the context line; "this" or "that flight" refers to it.

Your replies appear in Discord. Keep them short and easy to scan: lead with the answer, use plain sentences or a short list (Discord does not render tables), write dates like "Dec 10" and routes like SFO→TPE, and put thousands separators in miles. Don't mention tool names.`;

const CABIN_ENUM = { type: 'string', enum: api.SINGLE_CABINS };
const AIRPORT = (what) => ({ type: 'string', description: `${what} airport or city code, 3 letters (e.g. SFO, TPE, TYO)` });

function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** "Sun, Nov 15, 8:36 PM Pacific (38 min ago)" for a UTC ISO timestamp. */
function localTime(iso, nowMs) {
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  const text = d.toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
  });
  const mins = Math.round(Math.abs(nowMs - d.getTime()) / 60000);
  const span = mins < 90 ? `${mins} min` : mins < 48 * 60 ? `${Math.round(mins / 60)} hours` : `${Math.round(mins / 1440)} days`;
  return `${text} Pacific (${d.getTime() <= nowMs ? `${span} ago` : `in ${span}`})`;
}

/**
 * Rewrite every UTC timestamp in a tool result into the user's local time with
 * its age. The tracker stores UTC; a small model reading "…T04:36:00Z" reported
 * it as "4:36 AM today" when it was 8:36 PM the previous evening.
 */
function localizeTimes(value, nowMs) {
  if (typeof value === 'string') return ISO_UTC.test(value) ? localTime(value, nowMs) : value;
  if (Array.isArray(value)) return value.map(v => localizeTimes(v, nowMs));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, localizeTimes(v, nowMs)]));
  }
  return value;
}

function describeTrackResult(r) {
  const parts = [];
  if (r.addedDates.length) parts.push(`added ${plural(r.addedDates.length, 'date')}`);
  if (r.widenedDates.length) parts.push(`added cabins on ${plural(r.widenedDates.length, 'existing date')}`);
  if (!parts.length) parts.push('nothing new to add');
  return `**${r.route}**: ${parts.join(', ')} (${r.cabins.join(' + ')}). ${plural(r.totalDatesOnRoute, 'date')} now tracked on this route.`;
}

function describeUntrackResult(route, r) {
  if (!r.removed) return `**${route}** is not being tracked.`;
  const cleared = r.clearedFlights ? ` Cleared ${plural(r.clearedFlights, 'cached flight')}.` : '';
  if (r.removedEntireRoute) return `Stopped tracking **${route}** entirely.${cleared}`;
  const changed = r.removedDates.length + r.updatedDates.length;
  return `**${route}**: removed ${plural(changed, 'date')}; ${plural(r.remainingDates, 'date')} still tracked.${cleared}`;
}

/**
 * The tools. `run(args, ctx)` returns a JSON string, or throws api.InputError
 * for input the model should correct. `parameters` is omitted for tools that
 * take none. Model-supplied arguments are not schema-validated by the API, so
 * every value is checked in tracker-api before it is used.
 */
const TOOLS = [
  {
    name: 'list_tracked',
    description: 'The watch list: every tracked route (routeCount of them) with its dates, already grouped into ranges of consecutive days per cabin set. A gap between two ranges means those days are not tracked.',
    run: () => JSON.stringify(api.describeTracked()),
  },
  {
    name: 'get_flights',
    description: 'Award seats the tracker currently knows about, from its most recent searches. All filters are optional and combine. Returns confirmed (bookable) seats unless include_waitlist is true. Only tracked routes and dates have data.',
    parameters: {
      type: 'object',
      properties: {
        from: AIRPORT('Departure'),
        to: AIRPORT('Arrival'),
        date_from: { type: 'string', description: 'Earliest departure date, YYYY-MM-DD' },
        date_to: { type: 'string', description: 'Latest departure date, YYYY-MM-DD' },
        cabin: CABIN_ENUM,
        include_waitlist: { type: 'boolean' },
        max_miles: { type: 'integer', description: 'Only seats costing at most this many miles' },
      },
    },
    run: (a) => {
      const maxMiles = a.max_miles == null ? undefined : Number(a.max_miles);
      if (maxMiles !== undefined && !Number.isFinite(maxMiles)) throw new api.InputError('max_miles must be a number');
      return JSON.stringify(api.getFlights({
        from: a.from, to: a.to, dateFrom: a.date_from, dateTo: a.date_to,
        cabin: a.cabin, includeWaitlist: a.include_waitlist === true, maxMiles,
      }));
    },
  },
  {
    name: 'get_status',
    description: 'Tracker health: when the last check ran and how many searches it completed, whether a check is running now, whether ANA is rate-limiting or the login session has gone stale, and totals for the watch list and known seats.',
    run: () => JSON.stringify(api.getStatus()),
  },
  {
    name: 'recent_changes',
    description: 'History of what changed, newest first: seats that newly appeared, waitlist seats that became confirmed, confirmed seats that disappeared, and mileage price changes. Use for questions like "anything new since yesterday?".',
    parameters: {
      type: 'object',
      properties: {
        since_hours: { type: 'integer', description: 'How far back to look. Default 24.' },
        from: AIRPORT('Departure'),
        to: AIRPORT('Arrival'),
      },
    },
    run: (a) => {
      const hours = Number(a.since_hours);
      return JSON.stringify(api.recentEvents({ sinceHours: Number.isFinite(hours) && hours > 0 ? hours : 24, from: a.from, to: a.to }));
    },
  },
  {
    name: 'track',
    description: 'Add dates to the watch list for one route (one direction). Additive: never removes anything. `date` is a single day YYYY-MM-DD, or a month YYYY-MM (one date per week); give `until` as well to track every day from `date` through `until`. A request that adds many dates is held for the user to confirm.',
    parameters: {
      type: 'object',
      properties: {
        from: AIRPORT('Departure'),
        to: AIRPORT('Arrival'),
        date: { type: 'string', description: 'YYYY-MM-DD, or YYYY-MM for a weekly sample of that month' },
        until: { type: 'string', description: 'Last day of a daily range, YYYY-MM-DD' },
        cabin: { type: 'string', enum: api.TRACK_CABINS, description: '"both" = premium-economy + business (the default); "all" = all three' },
      },
      required: ['from', 'to', 'date'],
    },
    run: (a, ctx) => {
      const args = { from: a.from, to: a.to, date: a.date, until: a.until || undefined, cabin: a.cabin || 'both' };
      const plan = api.planTrack(args);
      if (plan.newDates.length > TRACK_CONFIRM_ABOVE_NEW_DATES) {
        return ctx.park('track', args, `track ${plural(plan.newDates.length, 'new date')} on ${plan.from}→${plan.to} (${plan.dates[0]} to ${plan.dates[plan.dates.length - 1]}, ${plan.cabinKeys.join(' + ')})`);
      }
      return JSON.stringify({ status: 'done', ...api.track(args) });
    },
  },
  {
    name: 'untrack',
    description: 'Remove from the watch list: a whole route (omit `date`), specific dates (`date`, optionally `until` for a range, or YYYY-MM for every tracked date in that month), or just one cabin on those dates (`cabin`). Also discards the cached seats for what is removed. Removing a whole route or more than a few dates is held for the user to confirm.',
    parameters: {
      type: 'object',
      properties: {
        from: AIRPORT('Departure'),
        to: AIRPORT('Arrival'),
        date: { type: 'string', description: 'YYYY-MM-DD or YYYY-MM. Omit to remove the whole route.' },
        until: { type: 'string', description: 'Last day of a range, YYYY-MM-DD. Requires `date`.' },
        cabin: CABIN_ENUM,
      },
      required: ['from', 'to'],
    },
    run: (a, ctx) => {
      if (a.until && !a.date) throw new api.InputError('`until` needs a start `date`');
      const args = { from: a.from, to: a.to, date: a.date || undefined, until: a.until || undefined, cabin: a.cabin || undefined };
      const plan = api.planUntrack(args);
      const route = `${plan.from}→${plan.to}`;
      if (!plan.exists) return JSON.stringify({ status: 'not_tracked', route });
      if (plan.affectedDates.length === 0) return JSON.stringify({ status: 'nothing_matched', route });
      if (plan.entireRoute || plan.affectedDates.length > UNTRACK_CONFIRM_ABOVE_DATES) {
        const what = plan.entireRoute && !plan.cabin
          ? `stop tracking ${route} entirely (${plural(plan.affectedDates.length, 'date')})`
          : `remove ${plan.cabin ? `${plan.cabin} on ` : ''}${plural(plan.affectedDates.length, 'date')} from ${route} (${plan.affectedDates[0]} to ${plan.affectedDates[plan.affectedDates.length - 1]})`;
        return ctx.park('untrack', args, what);
      }
      return JSON.stringify({ status: 'done', route, ...api.untrack(args) });
    },
  },
  {
    name: 'run_check_now',
    description: 'Start a search cycle now instead of waiting for the hourly run. Takes about 40 minutes; alerts for anything new arrive as usual.',
    run: (a, ctx) => {
      if (api.isCheckRunning()) return JSON.stringify({ status: 'already_running' });
      if (!ctx.triggerCheck) return JSON.stringify({ status: 'unavailable' });
      return JSON.stringify({ status: ctx.triggerCheck() === false ? 'already_running' : 'started' });
    },
  },
];

// What is sent to the API: the same list, in the same order, every request.
const TOOL_DECLARATIONS = TOOLS.map(({ name, description, parameters }) => ({
  type: 'function', name, description, ...(parameters ? { parameters } : {}),
}));

/** Why a request to Gemini failed, as a message for the user — or null if it isn't an API failure we recognise. */
function describeApiFailure(err) {
  const status = typeof err.status === 'number' ? err.status : null;
  const message = String(err.message || '');
  if (status === 401 || status === 403 || (status === 400 && /api[ _]key/i.test(message))) {
    return 'Gemini rejected the API key. Check `GEMINI_API_KEY` in `.env`, then restart the Discord bot.';
  }
  if (status === 429) return 'Gemini\'s rate limit or quota for this key is used up for now. Try again in a minute; if it keeps happening, check the quota in Google AI Studio.';
  if (status === 404) return 'Gemini does not know the configured model. Check `AGENT_MODEL` in `.env`.';
  if (status !== null) return `Gemini API error (${status}). Try again shortly.`;
  if (/fetch failed|network|timed? ?out|ECONN|ENOTFOUND/i.test(`${err.name} ${message} ${err.cause ? err.cause.code || err.cause.message : ''}`)) {
    return 'Could not reach the Gemini API. Check the network and try again.';
  }
  return null;
}

/**
 * @param {object} [opts]
 * @param {() => boolean} [opts.triggerCheck]  starts a search cycle; returns false if one is already running
 * @param {object} [opts.client]               a GoogleGenAI client (tests); default: built from the environment
 * @param {object} [opts.requestOptions]       per-request SDK options (tests turn retries off)
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {() => number} [opts.now]
 */
function createAgent({ triggerCheck = null, client = null, requestOptions = REQUEST_OPTIONS, env = process.env, now = Date.now } = {}) {
  const model = env.AGENT_MODEL || DEFAULT_MODEL;
  // Optional reasoning depth (minimal|low|medium|high|xhigh). Unset = the model's own default.
  const thinkingLevel = env.AGENT_EFFORT || null;
  const apiKey = env.GEMINI_API_KEY || env.GOOGLE_API_KEY;
  const configured = !!(client || apiKey);
  if (!client && configured) client = new GoogleGenAI({ apiKey });

  /** @type {Map<string, { steps: object[], lastUsed: number, notes: string[], queue: Promise<any> }>} */
  const conversations = new Map();
  /** @type {Map<string, { id: string, kind: 'track'|'untrack', args: object, summary: string, userId: string, conversationId: string, expiresAt: number }>} */
  const pending = new Map();
  let nextConfirmationId = 1;

  function conversation(id) {
    let conv = conversations.get(id);
    const stale = conv && (now() - conv.lastUsed > CONVERSATION_TTL_MS || conv.steps.length > CONVERSATION_MAX_STEPS);
    if (!conv || stale) {
      // Dropped whole, never trimmed — see the note on append-only history above.
      conv = { steps: [], lastUsed: now(), notes: [], queue: conv ? conv.queue : Promise.resolve() };
      conversations.set(id, conv);
    }
    return conv;
  }

  function userText(text, replyContext, notes) {
    const today = todayPST();
    const weekday = new Date(`${today}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
    const lines = [`[Context: today is ${weekday} ${today}, US Pacific time.`];
    for (const n of notes) lines.push(n);
    if (replyContext) lines.push(`The user is replying to this earlier bot message: ${replyContext}`);
    lines[lines.length - 1] += ']';
    return `${lines.join('\n')}\n\n${text}`;
  }

  /** Run one function call; always returns a function_result step. */
  async function runTool(call, ctx) {
    const tool = TOOLS.find(t => t.name === call.name);
    const result = { type: 'function_result', call_id: call.id, name: call.name };
    if (!tool) return { ...result, is_error: true, result: `Unknown tool "${call.name}"` };
    try {
      ctx.toolsRan = true;
      const output = JSON.parse(await tool.run(call.arguments || {}, ctx));
      return { ...result, result: JSON.stringify(localizeTimes(output, now())) };
    } catch (e) {
      if (!(e instanceof api.InputError)) console.error(`[Chat] Tool ${call.name} failed:`, e);
      return { ...result, is_error: true, result: `Error: ${e.message}` };
    }
  }

  /**
   * One user message → model/tool loop → final interaction.
   * Returns the full step history (prior steps + everything this turn added).
   */
  async function runTurn(history, text, ctx) {
    const steps = [...history, { type: 'user_input', content: [{ type: 'text', text }] }];
    let interaction = null;
    let finished = false;
    for (let i = 0; i < MAX_MODEL_CALLS_PER_TURN && !finished; i++) {
      interaction = await client.interactions.create({
        model,
        system_instruction: SYSTEM_PROMPT,
        tools: TOOL_DECLARATIONS,
        store: false,
        ...(thinkingLevel ? { generation_config: { thinking_level: thinkingLevel } } : {}),
        input: steps,
      }, requestOptions);

      const produced = interaction.steps || [];
      steps.push(...produced); // exactly as received: thought + function_call steps carry signatures
      const calls = produced.filter(s => s.type === 'function_call');
      if (calls.length === 0) {
        finished = true;
      } else {
        // Every call gets a result, in order, before the next request.
        for (const call of calls) steps.push(await runTool(call, ctx));
      }
    }
    return { interaction, steps, finished };
  }

  function replyText(interaction) {
    if (interaction.output_text) return String(interaction.output_text).trim();
    return (interaction.steps || [])
      .filter(s => s.type === 'model_output')
      .flatMap(s => (s.content || []).filter(c => c.type === 'text').map(c => c.text))
      .join('\n').trim();
  }

  async function handleNow({ text, conversationId, userId, replyContext }) {
    if (!configured) return { text: SETUP_HINT, confirmations: [] };
    const conv = conversation(conversationId);
    const ctx = {
      userId, conversationId, triggerCheck, confirmations: [], toolsRan: false,
      park(kind, args, summary) {
        const id = `${now().toString(36)}${(nextConfirmationId++).toString(36)}`;
        pending.set(id, { id, kind, args, summary, userId, conversationId, expiresAt: now() + CONFIRMATION_TTL_MS });
        this.confirmations.push({ id, kind, summary });
        return JSON.stringify({ status: 'awaiting_user_confirmation', nothing_changed_yet: true, shown_to_user: `A Confirm button for: ${summary}` });
      },
    };
    const content = userText(text, replyContext, conv.notes.splice(0));

    let turn;
    try {
      try {
        turn = await runTurn(conv.steps, content, ctx);
      } catch (err) {
        // A rejected history (a signature the API no longer accepts, a model
        // change under an old conversation) is decided before anything runs:
        // start fresh, once. Not for key problems, which a retry can't fix.
        const retryable = err.status === 400 && !/api[ _]key/i.test(String(err.message)) && conv.steps.length > 0 && !ctx.toolsRan;
        if (!retryable) throw err;
        console.log(`[Chat] Request rejected with history (${String(err.message).slice(0, 160)}) — retrying as a new conversation`);
        conv.steps = [];
        turn = await runTurn([], content, ctx);
      }
    } catch (err) {
      conv.steps = [];
      const failure = describeApiFailure(err);
      if (!failure) throw err;
      console.error(`[Chat] Gemini request failed (${err.status ?? err.name}): ${String(err.message).slice(0, 300)}`);
      return { text: failure, confirmations: ctx.confirmations };
    }

    const { interaction, steps, finished } = turn;
    const u = interaction.usage || {};
    console.log(`[Chat] ${model} status=${interaction.status} in=${u.total_input_tokens ?? '?'} out=${u.total_output_tokens ?? '?'} tools=${ctx.toolsRan}`);

    const reply = replyText(interaction);
    const ok = finished && (interaction.status === 'completed' || interaction.status === undefined) && reply;
    if (!ok) {
      // Blocked, failed, cut off, or still asking for tools at the call cap:
      // this turn can't be continued from, so don't carry it forward.
      conv.steps = [];
      const why = !finished ? 'That took more steps than I allow in one go. Try asking for a smaller piece.'
        : `I couldn't produce an answer for that (${interaction.status || 'no output'}). Try rephrasing.`;
      return { text: reply || why, confirmations: ctx.confirmations };
    }
    conv.steps = steps;
    conv.lastUsed = now();
    return { text: reply, confirmations: ctx.confirmations };
  }

  /**
   * Answer one message. Turns in the same conversation run one at a time.
   * @returns {Promise<{ text: string, confirmations: Array<{ id: string, kind: string, summary: string }> }>}
   */
  function handle(request) {
    const conv = conversation(request.conversationId);
    const turn = conv.queue.then(() => handleNow(request));
    conv.queue = turn.catch(() => {});
    return turn;
  }

  /**
   * Run (or cancel) a parked change. Only the user it was shown to may answer.
   * @returns {{ ok: boolean, text: string }}
   */
  function resolveConfirmation(id, userId, accept) {
    const p = pending.get(id);
    if (!p || p.expiresAt < now()) {
      pending.delete(id);
      return { ok: false, text: 'That confirmation has expired. Ask again if you still want it.' };
    }
    if (p.userId !== userId) return { ok: false, text: 'Only the person who asked can confirm this.' };
    pending.delete(id);

    const conv = conversations.get(p.conversationId);
    const note = (outcome) => { if (conv) conv.notes.push(`Earlier request "${p.summary}": ${outcome}`); };
    if (!accept) {
      note('the user cancelled it; nothing changed.');
      return { ok: true, text: `Cancelled — did not ${p.summary}.` };
    }
    try {
      let text;
      if (p.kind === 'track') {
        text = describeTrackResult(api.track(p.args));
      } else {
        const plan = api.planUntrack(p.args);
        text = describeUntrackResult(`${plan.from}→${plan.to}`, api.untrack(p.args));
      }
      note(`the user confirmed and it was done. ${text}`);
      return { ok: true, text: `✅ ${text}` };
    } catch (e) {
      note(`the user confirmed but it failed: ${e.message}`);
      return { ok: false, text: `Could not do that: ${e.message}` };
    }
  }

  return { configured, model, handle, resolveConfirmation };
}

module.exports = { createAgent, localizeTimes, SYSTEM_PROMPT, SETUP_HINT, DEFAULT_MODEL, TOOL_DECLARATIONS, TRACK_CONFIRM_ABOVE_NEW_DATES, UNTRACK_CONFIRM_ABOVE_DATES };
