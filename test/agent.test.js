/**
 * Tests for src/agent.js (the Gemini chat agent) and src/discord-chat.js.
 * Run: node test/agent.test.js
 *
 * No API key or network: Google's real SDK is pointed at a local HTTP server
 * that plays back scripted Interactions API responses, so the SDK, our
 * request/tool loop and the tools themselves are all exercised for real.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ana-agent-test-'));
process.env.ANA_DATA_DIR = DATA;
delete process.env.ROUTES;
const { GoogleGenAI } = require('@google/genai');
const api = require('../src/tracker-api');
const { createAgent, SYSTEM_PROMPT, SETUP_HINT } = require('../src/agent');
const chatMod = require('../src/discord-chat');

const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const reset = () => { for (const f of fs.readdirSync(DATA)) fs.rmSync(path.join(DATA, f), { force: true }); };
const trackedDates = (from, to) => Object.keys((api.listTracked().routes.find(r => r.from === from && r.to === to) || { dates: {} }).dates).sort();

// --- scripted Interactions API ----------------------------------------------
let script = [];
let requests = [];
const fnCall = (id, name, args) => ({ type: 'function_call', id, name, arguments: args });
const say = (text) => ({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text }] }] });
const call = (...calls) => ({ status: 'requires_action', steps: [{ type: 'thought', signature: `sig-${calls[0].id}` }, ...calls] });
const fail = (httpStatus, message, status = 'ERROR') => ({ httpStatus, error: { code: httpStatus, message, status } });

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', () => {
    requests.push({ method: req.method, url: req.url, key: req.headers['x-goog-api-key'], body: JSON.parse(body) });
    const next = script.shift();
    res.setHeader('content-type', 'application/json');
    if (!next) { res.statusCode = 418; return res.end(JSON.stringify({ error: { code: 418, message: 'script exhausted', status: 'TEST' } })); }
    if (next.httpStatus) { res.statusCode = next.httpStatus; return res.end(JSON.stringify({ error: next.error })); }
    res.end(JSON.stringify({ id: `int_${requests.length}`, object: 'interaction', model: 'gemini-4-hydrogen', role: 'model',
      usage: { total_input_tokens: 100, total_output_tokens: 20 }, ...next }));
  });
});

/** function_result steps present in request number n (0-based). */
const toolResults = (n) => requests[n].body.input.filter(s => s.type === 'function_result');
const lastUserText = (n) => requests[n].body.input.filter(s => s.type === 'user_input').at(-1).content[0].text;

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

function newAgent(extra = {}) {
  const client = new GoogleGenAI({ apiKey: 'test-key', httpOptions: { baseUrl: `http://127.0.0.1:${server.address().port}` } });
  return createAgent({ client, env: {}, requestOptions: { maxRetries: 0 }, ...extra });
}
const ask = (agent, text, more = {}) => agent.handle({ text, conversationId: 'c1', userId: 'owner', ...more });

// --- the agent ---------------------------------------------------------------
test('a clear request is carried out and the reply returned; the request is built as intended', async () => {
  reset(); requests = [];
  script = [call(fnCall('t1', 'track', { from: 'SFO', to: 'TPE', date: day(30), until: day(32), cabin: 'business' })), say('Tracking SFO→TPE business for 3 days.')];
  const r = await ask(newAgent(), 'watch SFO to TPE business for those three days');
  assert.strictEqual(r.text, 'Tracking SFO→TPE business for 3 days.');
  assert.deepStrictEqual(r.confirmations, []);
  assert.deepStrictEqual(trackedDates('SFO', 'TPE'), [day(30), day(31), day(32)]);

  const first = requests[0];
  assert.strictEqual(first.method, 'POST');
  assert.match(first.url, /\/interactions$/);
  assert.strictEqual(first.key, 'test-key');
  assert.strictEqual(first.body.model, 'gemini-4-hydrogen');
  assert.strictEqual(first.body.store, false, 'nothing is kept on Google\'s side');
  assert.strictEqual(first.body.system_instruction, SYSTEM_PROMPT);
  assert.strictEqual(first.body.generation_config, undefined);
  assert.deepStrictEqual(first.body.tools.map(t => t.name), ['list_tracked', 'get_flights', 'get_status', 'recent_changes', 'track', 'untrack', 'run_check_now']);
  assert.ok(first.body.tools.every(t => t.type === 'function'));
  assert.strictEqual(first.body.input.length, 1);
  assert.match(lastUserText(0), /^\[Context: today is \w+ \d{4}-\d{2}-\d{2}, US Pacific time\.\]\n\nwatch SFO to TPE/);
  const [result] = toolResults(1);
  assert.strictEqual(result.call_id, 't1');
  assert.match(result.result, /"status":"done"/);
});

test('nothing volatile is in the system prompt (history must replay unchanged)', async () => {
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(SYSTEM_PROMPT));
});

test('the next message replays the earlier steps exactly as received, thought signature included', async () => {
  reset(); requests = [];
  const agent = newAgent();
  script = [call(fnCall('t1', 'list_tracked', {})), say('Nothing tracked.')];
  await ask(agent, 'what am I tracking?');
  script = [say('Still nothing.')];
  await ask(agent, 'and now?');

  const replay = requests[2].body.input;
  assert.deepStrictEqual(replay.map(s => s.type), ['user_input', 'thought', 'function_call', 'function_result', 'model_output', 'user_input']);
  assert.deepStrictEqual(replay[0], requests[0].body.input[0]);
  assert.deepStrictEqual(replay[1], { type: 'thought', signature: 'sig-t1' });
  assert.deepStrictEqual(replay[2], { type: 'function_call', id: 't1', name: 'list_tracked', arguments: {} });
  assert.deepStrictEqual(replay[4], { type: 'model_output', content: [{ type: 'text', text: 'Nothing tracked.' }] });
  assert.match(lastUserText(2), /and now\?$/);
  assert.strictEqual(requests[2].body.system_instruction, requests[0].body.system_instruction);
  assert.deepStrictEqual(requests[2].body.tools, requests[0].body.tools);
});

test('a large track is NOT executed: it is parked and only the asking user\'s confirmation runs it', async () => {
  reset(); requests = [];
  const agent = newAgent();
  script = [call(fnCall('t1', 'track', { from: 'SFO', to: 'TPE', date: day(30), until: day(49) })), say('That is 20 new dates — confirm with the button.')];
  const r = await ask(agent, 'track every day for the next three weeks or so');
  assert.deepStrictEqual(trackedDates('SFO', 'TPE'), []);
  assert.strictEqual(r.confirmations.length, 1);
  assert.strictEqual(r.confirmations[0].kind, 'track');
  assert.match(r.confirmations[0].summary, /track 20 new dates on SFO→TPE/);
  assert.match(toolResults(1)[0].result, /awaiting_user_confirmation/);

  const id = r.confirmations[0].id;
  assert.strictEqual(agent.resolveConfirmation(id, 'someone-else', true).ok, false);
  assert.deepStrictEqual(trackedDates('SFO', 'TPE'), []);
  const done = agent.resolveConfirmation(id, 'owner', true);
  assert.strictEqual(done.ok, true);
  assert.strictEqual(trackedDates('SFO', 'TPE').length, 20);
  assert.strictEqual(agent.resolveConfirmation(id, 'owner', true).ok, false, 'a confirmation can be used once');

  // The model hears about the outcome on the next turn, in the new user message.
  script = [say('Yes, all 20 are tracked.')];
  await ask(agent, 'did that go through?');
  assert.match(lastUserText(2), /the user confirmed and it was done/);
});

test('removing a whole route is parked; cancelling leaves it alone', async () => {
  reset(); requests = [];
  api.track({ from: 'SFO', to: 'TPE', date: day(30), until: day(31) });
  const agent = newAgent();
  script = [call(fnCall('t1', 'untrack', { from: 'SFO', to: 'TPE' })), say('Confirm to stop tracking SFO→TPE.')];
  const r = await ask(agent, 'stop tracking SFO to TPE');
  assert.strictEqual(r.confirmations[0].kind, 'untrack');
  assert.match(r.confirmations[0].summary, /stop tracking SFO→TPE entirely \(2 dates\)/);
  assert.strictEqual(trackedDates('SFO', 'TPE').length, 2);
  assert.match(agent.resolveConfirmation(r.confirmations[0].id, 'owner', false).text, /Cancelled/);
  assert.strictEqual(trackedDates('SFO', 'TPE').length, 2);
});

test('a small untrack runs straight away; an expired confirmation does nothing', async () => {
  reset(); requests = [];
  api.track({ from: 'SFO', to: 'TPE', date: day(30), until: day(36) });
  let clock = Date.now();
  const agent = newAgent({ now: () => clock });
  script = [call(fnCall('t1', 'untrack', { from: 'SFO', to: 'TPE', date: day(30) })), say('Removed.')];
  const small = await ask(agent, 'drop the first day');
  assert.deepStrictEqual(small.confirmations, []);
  assert.strictEqual(trackedDates('SFO', 'TPE').length, 6);

  script = [call(fnCall('t2', 'untrack', { from: 'SFO', to: 'TPE', date: day(31), until: day(35) })), say('Confirm to remove 5 dates.')];
  const big = await ask(agent, 'drop five more');
  clock += 11 * 60 * 1000;
  assert.match(agent.resolveConfirmation(big.confirmations[0].id, 'owner', true).text, /expired/);
  assert.strictEqual(trackedDates('SFO', 'TPE').length, 6);
});

test('bad tool input and unknown tools come back to the model as error results, one per call, in order', async () => {
  reset(); requests = [];
  script = [call(
    fnCall('t1', 'track', { from: 'San Francisco', to: 'TPE', date: day(30) }),
    fnCall('t2', 'untrack', { from: 'SFO', to: 'TPE', until: day(30) }),
    fnCall('t3', 'book_ticket', {}),
  ), say('I need airport codes.')];
  const r = await ask(newAgent(), 'track san francisco to taipei');
  assert.strictEqual(r.text, 'I need airport codes.');
  const results = toolResults(1);
  assert.deepStrictEqual(results.map(b => b.call_id), ['t1', 't2', 't3']);
  assert.ok(results.every(b => b.is_error === true));
  assert.match(results[0].result, /3-letter airport/);
  assert.match(results[2].result, /Unknown tool/);
});

test('get_flights and recent_changes hand the model the tracker\'s data', async () => {
  reset(); requests = [];
  fs.writeFileSync(path.join(DATA, 'state.json'), JSON.stringify({ flights: { k: { status: 'confirmed', route: 'SFO→TYO', date: '2026-12-06', flightNumber: 'NH107', cabinDesc: 'NH107 Premium Economy Class', miles: 36000, taxUsd: 80 } } }));
  require('../src/events').recordEvent('new', { route: 'SFO→TYO', date: '2026-12-06', flightNumber: 'NH107', miles: 36000 });
  script = [call(fnCall('t1', 'get_flights', { to: 'TYO', max_miles: '60000' }), fnCall('t2', 'recent_changes', { since_hours: 12 })), say('NH107 on Dec 6 for 36,000 miles.')];
  await ask(newAgent(), 'anything bookable to Tokyo under 60k?');
  const [flights, changes] = toolResults(1).map(b => JSON.parse(b.result));
  assert.strictEqual(flights.count, 1, 'a numeric string for max_miles is accepted');
  assert.strictEqual(flights.flights[0].miles, 36000);
  assert.strictEqual(changes.events[0].type, 'new');
});

test('run_check_now starts a check unless one is already running', async () => {
  reset(); requests = [];
  let started = 0;
  const agent = newAgent({ triggerCheck: () => { started++; return true; } });
  script = [call(fnCall('t1', 'run_check_now', {})), say('Started.')];
  await ask(agent, 'check now');
  assert.strictEqual(started, 1);
  assert.match(toolResults(1)[0].result, /"started"/);

  fs.writeFileSync(path.join(DATA, 'run.lock'), String(process.pid)); // a scheduled run is in progress
  requests = [];
  script = [call(fnCall('t2', 'run_check_now', {})), say('Already running.')];
  await ask(agent, 'check again', { conversationId: 'c2' });
  assert.strictEqual(started, 1);
  assert.match(toolResults(1)[0].result, /already_running/);
});

test('a reply-to-alert is passed along as context', async () => {
  reset(); requests = [];
  script = [say('ok')];
  await ask(newAgent(), 'untrack this', { replyContext: 'ANA Award Seat Found! | Date: 2026-12-06 | Flight: NH107' });
  assert.match(lastUserText(0), /replying to this earlier bot message: ANA Award Seat Found! \| Date: 2026-12-06 \| Flight: NH107\]\n\nuntrack this$/);
});

test('a rejected API key gives a setup message, is not retried, and does not poison the conversation', async () => {
  reset(); requests = [];
  const agent = newAgent();
  script = [say('first')];
  await ask(agent, 'hi');
  script = [fail(400, 'API key not valid. Please pass a valid API key.', 'INVALID_ARGUMENT')];
  assert.match((await ask(agent, 'hi')).text, /rejected the API key/);
  assert.strictEqual(requests.length, 2, 'a key error with history must not trigger the fresh-conversation retry');
  script = [fail(403, 'Permission denied', 'PERMISSION_DENIED')];
  assert.match((await ask(agent, 'hi')).text, /rejected the API key/);
  script = [say('hello')];
  assert.strictEqual((await ask(agent, 'hi again')).text, 'hello');
  assert.strictEqual(requests.at(-1).body.input.length, 1);
});

test('quota, unknown-model and server errors become short messages', async () => {
  requests = [];
  const agent = newAgent();
  script = [fail(429, 'Quota exceeded', 'RESOURCE_EXHAUSTED')];
  assert.match((await ask(agent, 'hi')).text, /rate limit or quota/);
  script = [fail(404, 'model not found', 'NOT_FOUND')];
  assert.match((await ask(agent, 'hi')).text, /AGENT_MODEL/);
  script = [fail(503, 'overloaded', 'UNAVAILABLE')];
  assert.match((await ask(agent, 'hi')).text, /Gemini API error \(503\)/);
  assert.strictEqual(requests.length, 3, 'tests run with retries off');
});

test('a history the API rejects is dropped and the message retried once as a new conversation', async () => {
  reset(); requests = [];
  const agent = newAgent();
  script = [say('first')];
  await ask(agent, 'one');
  script = [fail(400, 'Invalid thought signature', 'INVALID_ARGUMENT'), say('recovered')];
  assert.strictEqual((await ask(agent, 'two')).text, 'recovered');
  assert.strictEqual(requests[2].body.input.length, 1, 'retry carries only the new message');
});

test('a failed or empty interaction is reported and that turn is not carried forward', async () => {
  reset(); requests = [];
  const agent = newAgent();
  script = [{ status: 'failed', steps: [] }];
  assert.match((await ask(agent, 'something')).text, /couldn't produce an answer.*failed/);
  script = [say('fine')];
  await ask(agent, 'next');
  assert.strictEqual(requests[1].body.input.length, 1);
});

test('a model that never stops calling tools is cut off after 8 requests', async () => {
  reset(); requests = [];
  const agent = newAgent();
  script = Array.from({ length: 12 }, (_, i) => call(fnCall(`t${i}`, 'get_status', {})));
  assert.match((await ask(agent, 'loop')).text, /more steps than I allow/);
  assert.strictEqual(requests.length, 8);
  script = [say('fresh')];
  await ask(agent, 'next');
  assert.strictEqual(requests.at(-1).body.input.length, 1, 'the abandoned turn is not replayed');
});

test('without a key the agent explains how to set it up and calls nothing', async () => {
  requests = [];
  const agent = createAgent({ env: {} });
  assert.strictEqual(agent.configured, false);
  assert.strictEqual((await ask(agent, 'hi')).text, SETUP_HINT);
  assert.match(SETUP_HINT, /GEMINI_API_KEY/);
  assert.strictEqual(requests.length, 0);
  assert.strictEqual(createAgent({ env: { GEMINI_API_KEY: 'k' } }).configured, true);
});

test('AGENT_MODEL and AGENT_EFFORT override the defaults', async () => {
  requests = [];
  script = [say('ok')];
  await ask(newAgent({ env: { AGENT_MODEL: 'gemini-3.5-flash-lite', AGENT_EFFORT: 'low' } }), 'hi');
  assert.strictEqual(requests[0].body.model, 'gemini-3.5-flash-lite');
  assert.deepStrictEqual(requests[0].body.generation_config, { thinking_level: 'low' });
});

// --- Discord glue ------------------------------------------------------------
test('helpers: mention stripping, splitting, allow-list parsing, alert text', async () => {
  assert.strictEqual(chatMod.stripBotMention('<@999>  track   SFO <@!999>', '999'), 'track SFO');
  assert.strictEqual(chatMod.stripBotMention('<@111> hi', '999'), '<@111> hi');
  const long = Array.from({ length: 400 }, (_, i) => `line number ${i}`).join('\n');
  const chunks = chatMod.splitForDiscord(long);
  assert.ok(chunks.length > 1 && chunks.every(c => c.length <= 1900));
  assert.strictEqual(chunks.join('\n'), long);
  assert.deepStrictEqual(chatMod.splitForDiscord('short'), ['short']);
  assert.deepStrictEqual([...chatMod.parseAllowedUsers(' 12345678, abc ,987654321 ')], ['12345678', '987654321']);
  assert.strictEqual(chatMod.parseAllowedUsers(''), null);
  assert.strictEqual(chatMod.describeMessage({ content: '', embeds: [{ title: 'Seat Found', fields: [{ name: 'Date', value: '2026-12-06' }] }] }), 'Seat Found | Date: 2026-12-06');
  const rows = chatMod.confirmationRows([{ id: 'abc', kind: 'untrack', summary: 'x'.repeat(200) }]);
  const [yes, no] = rows[0].toJSON().components;
  assert.strictEqual(yes.custom_id, 'anachat:yes:abc');
  assert.ok(yes.label.length <= 80);
  assert.strictEqual(no.custom_id, 'anachat:no:abc');
});

function fakeDiscord({ agentResult = { text: 'hello', confirmations: [] }, env = { DISCORD_GUILD_ID: 'g1' } } = {}) {
  const client = new EventEmitter();
  client.user = { id: '999' };
  client.guilds = { fetch: async () => ({ ownerId: '42' }) };
  const asked = [];
  const agent = { configured: true, model: 'm', handle: async (req) => { asked.push(req); return agentResult; }, resolveConfirmation: (id, user, accept) => ({ ok: true, text: `${accept ? 'did' : 'cancelled'} ${id} for ${user}` }) };
  const quiet = console.log; console.log = () => {};
  const chat = chatMod.attachChat(client, agent, { env });
  console.log = quiet;
  const sent = [];
  const message = (over = {}) => ({
    author: { id: '42', bot: false }, guildId: 'g1', channelId: 'ch1', content: '<@999> what is bookable?',
    mentions: { users: new Map([['999', {}]]) }, reference: null,
    channel: { sendTyping: async () => {}, send: async (p) => sent.push(p) },
    reply: async (p) => sent.push(p),
    ...over,
  });
  const deliver = async (m) => { client.emit('messageCreate', m); await new Promise(r => setTimeout(r, 30)); };
  return { client, chat, asked, sent, message, deliver };
}

test('answers the owner when mentioned, with the mention stripped and nobody pinged', async () => {
  const d = fakeDiscord();
  await d.deliver(d.message());
  assert.strictEqual(d.asked[0].text, 'what is bookable?');
  assert.strictEqual(d.asked[0].conversationId, 'ch:ch1:42');
  assert.strictEqual(d.sent[0].content, 'hello');
  assert.deepStrictEqual(d.sent[0].allowedMentions, { parse: [], repliedUser: false });
});

test('stays silent for other people, other bots, and messages that do not mention it', async () => {
  const d = fakeDiscord();
  await d.deliver(d.message({ author: { id: '7', bot: false } }));
  await d.deliver(d.message({ author: { id: '42', bot: true } }));
  await d.deliver(d.message({ mentions: { users: new Map() }, content: 'just chatting' }));
  assert.strictEqual(d.asked.length, 0);
  assert.strictEqual(d.sent.length, 0);
});

test('answers DMs from the owner, and AGENT_USER_IDS replaces the server-owner default', async () => {
  const d = fakeDiscord();
  await d.deliver(d.message({ guildId: null, mentions: { users: new Map() }, content: 'status?' }));
  assert.strictEqual(d.asked[0].conversationId, 'dm:42');
  const e = fakeDiscord({ env: { DISCORD_GUILD_ID: 'g1', AGENT_USER_IDS: '7777777' } });
  await e.deliver(e.message());
  assert.strictEqual(e.asked.length, 0, 'the server owner is no longer allowed');
  await e.deliver(e.message({ author: { id: '7777777', bot: false } }));
  assert.strictEqual(e.asked.length, 1);
});

test('a reply to one of the bot\'s alerts carries the alert text; replies to others do not', async () => {
  const d = fakeDiscord();
  const alert = { author: { id: '999' }, content: '', embeds: [{ title: 'ANA Award Seat Found!', fields: [{ name: 'Flight', value: 'NH107' }] }] };
  await d.deliver(d.message({ content: '<@999> untrack this', reference: { messageId: 'm1' }, fetchReference: async () => alert }));
  assert.strictEqual(d.asked[0].replyContext, 'ANA Award Seat Found! | Flight: NH107');
  await d.deliver(d.message({ reference: { messageId: 'm2' }, fetchReference: async () => ({ author: { id: '5' }, content: 'someone else', embeds: [] }) }));
  assert.strictEqual(d.asked[1].replyContext, null);
});

test('pending confirmations are shown as buttons, and a click resolves one and removes its row', async () => {
  const d = fakeDiscord({ agentResult: { text: 'Confirm below.', confirmations: [{ id: 'a1', kind: 'untrack', summary: 'stop tracking SFO→TPE' }, { id: 'b2', kind: 'track', summary: 'track 20 dates' }] } });
  await d.deliver(d.message());
  assert.strictEqual(d.sent[0].components.length, 2);

  const rows = d.sent[0].components.map(r => ({ components: r.toJSON().components.map(c => ({ customId: c.custom_id })) }));
  let updated = null;
  const handled = await d.chat.handleButton({ customId: 'anachat:yes:a1', user: { id: '42' }, message: { content: 'Confirm below.', components: rows }, update: async (p) => { updated = p; }, reply: async () => {} });
  assert.strictEqual(handled, true);
  assert.match(updated.content, /Confirm below\.\n\ndid a1 for 42/);
  assert.strictEqual(updated.components.length, 1);
  assert.strictEqual(updated.components[0].components[0].customId, 'anachat:yes:b2');

  let refused = null;
  await d.chat.handleButton({ customId: 'anachat:yes:b2', user: { id: '7' }, message: { content: '', components: [] }, update: async () => { throw new Error('must not update'); }, reply: async (p) => { refused = p; } });
  assert.strictEqual(refused.flags, 64, 'ephemeral: only the clicker sees the refusal');
  assert.strictEqual(await d.chat.handleButton({ customId: 'something:else', user: { id: '42' } }), false);
});

// --- run ---------------------------------------------------------------------
server.listen(0, '127.0.0.1', async () => {
  const quietLog = console.log, quietErr = console.error;
  for (const [name, fn] of tests) {
    const lines = [];
    console.log = (...a) => lines.push(a.join(' ')); // the agent's own [Chat] logging
    console.error = (...a) => lines.push(a.join(' '));
    try {
      await fn();
      console.log = quietLog; console.error = quietErr;
      passed++; console.log(`  ✓ ${name}`);
    } catch (e) {
      console.log = quietLog; console.error = quietErr;
      console.error(`  ✗ ${name}\n    ${e.stack}\n    log: ${lines.join(' / ')}`);
      process.exitCode = 1;
    }
  }
  server.close();
  fs.rmSync(DATA, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${tests.length - passed} failed`);
});
