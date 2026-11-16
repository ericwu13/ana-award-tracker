# ANA Award Tracker — Claude Code Instructions

## Architecture

Two independent processes share `data/cookies.json` and `data/state.json`:

- **`discord-bot.js`** — persistent (Task Scheduler at login). Runs Discord slash commands, the chat agent (see "Chat agent"), cookie server (port 9444), and puppeteer keep-alive (every 25 min). Changes to its in-memory code require a process restart. Its output goes to `data/logs/discord-bot-YYYY-MM.log`.
- **`run-once.js`** → `src/index.js` — spawned fresh every 60 min by Task Scheduler. Single search cycle, exits. Always loads the latest code from disk — no restart needed for code changes to take effect.

The Chrome extension (`cookie-exporter/`) auto-pushes cookies every 5-10 min from the user's real Chrome browser. Its content script (`content.js`) reloads the ANA tab every 14 min to keep the server-side session alive. Full pipeline documented in `docs/cookie-pipeline.md`.

## Running tests

```bash
node test/routes.test.js          # routes data model, per-date cabins, date parsing
node test/parser.test.js          # per-flight miles extraction from ANA HTML
node test/gone-detection.test.js  # GONE grace period
node test/chrome-cleanup.test.js  # orphaned bot-Chrome classification
node test/browser-window.test.js  # BOT_WINDOW_POSITION resolution
node test/bot-desktop.test.js     # BOT_DESKTOP resolution + relaunch onto a hidden desktop
node test/tracker-api.test.js     # shared track/untrack/flights/status layer + event log
node test/agent.test.js           # chat agent (real SDK vs a scripted local API) + Discord glue
```

No test framework — uses built-in `assert`. Exits with code 1 on failure.

## Key data files

| File | Format | Written by |
|---|---|---|
| `data/routes.json` | `{ routes: [{ from, to, dates: { 'YYYY-MM-DD': ['premium-economy','business'] } }] }` | Discord commands, cleanup |
| `data/state.json` | `{ flights: { key: flight }, lastChecked: { combo: timestamp }, lastCoverage: {...} }` | run-once.js search cycle |
| `data/cookies.json` | Array of cookie objects | Chrome extension + keep-alive |
| `data/session-stale.flag` | Presence = all retries halted | keep-alive on Akamai block |
| `data/events.jsonl` | One JSON object per line: `{ ts, type: new\|upgraded\|gone\|miles_changed, route, date, flightNumber, cabin, status, miles, taxUsd }` | run-once.js search cycle (append-only) |

## Critical technical details

### Akamai bot detection
ANA uses Akamai Bot Manager. The "heavy traffic" / "request cannot be accepted" page is bot detection, NOT rate limiting. Automated login via puppeteer is blocked. Login must happen in the user's real Chrome browser. The bot only uses puppeteer for searches (less aggressively blocked).

### Orphaned Chrome cleanup
`puppeteer-real-browser` launches Chrome via `chrome-launcher`, whose profile dir is `%TEMP%\lighthouse.<random>` — the word "puppeteer" is **never** on the command line, so don't match on it. On a *healthy* `browser.close()`, puppeteer-real-browser's `disconnected` hook already runs chrome-launcher's `kill()` and deletes the temp profile; the leak only happens when that hook never fires (CDP `Browser.close` timeout, crash, Task Scheduler kill). `src/chrome-cleanup.js` is the backstop: it identifies bot browsers by a `--user-data-dir`/`--database` pointing at `%TEMP%\lighthouse.<n>` and kills them when their parent `node.exe` is dead (orphan) or when `ownerPid` is the caller (its own leftovers, called after `browser.close()` was attempted). It runs (async) in `index.js` `finally`, the keep-alive `finally`, and `start.js` child exit. Manual: `node cleanup-chrome.js [--all|--list]`. The user's real Chrome has no lighthouse profile and is never touched.

Safety rules baked in — keep them: if the PowerShell listing fails, nothing is killed or swept (an empty list ≠ no bot browsers); the kill pipeline re-checks name + command line so a reused pid can't be hit; helpers whose browser pid is still alive are never killed even if its command line is unreadable; stale `%TEMP%\lighthouse.*` dirs are only swept once >10 min old (chrome-launcher mkdirs before Chrome shows up in the process list). `--disable-backgrounding-occluded-windows` is already in chrome-launcher's DEFAULT_FLAGS; `customConfig.chromiumFlags` is ignored by chrome-launcher, and `customConfig.chromeFlags` would *replace* the whole flag list — don't use either.

### Hiding bot windows
Three things that do NOT work, with the reason, so nobody retries them:
- **Headless / non-interactive session** (Task Scheduler "run whether user is logged on or not"): Akamai fingerprints the WebGL renderer and screen metrics; the cookies come from the user's real Chrome on the same GPU, so a SwiftShader renderer is a mismatch.
- **Minimizing** (CDP `Browser.setWindowBounds windowState=minimized`): on Windows a minimized window is HIDDEN to the renderer and BeginMainFrame stops — puppeteer `click()` (IntersectionObserver) never resolves (90 s timeout), `waitForFunction`'s default rAF polling evaluates once, `mouse.move` waits on a 5 s fallback per step. Breaks searches and the keep-alive re-auth path.
- **`--start-minimized`**: not a Chrome switch; silently ignored.

What works, part 1: an off-screen `--window-position`. Chromium applies the command-line position verbatim (no clamp onto a display), and chrome-launcher's default flags disable native occlusion tracking (`CalculateNativeWinOcclusion`) and occluded-window backgrounding, so the page stays VISIBLE — rAF, input and `visibilityState` identical to an on-screen window. The legacy hard-coded positions (-2560 / -1600) only hide windows on a single 1080p monitor; on a multi-monitor desktop they land on the left display. `src/browser-window.js` resolves the position from `BOT_WINDOW_POSITION=x,y` (unset = legacy, byte-identical to before; recommended `-20000,0`). Search sessions stagger +320 px per id. Values are capped at ±20000: `-32000` is the sentinel Windows moves minimized HWNDs to (a known hidden-window fingerprint heuristic), and `--window-position` is in DIPs scaled by the nearest display, so larger values can overflow int16 in Win32 after 150% DPI. Keep `y` inside the monitor row so the nearest display (hence DPR / `screen.*`) stays the same.

Off-screen positioning alone still leaks onto the desktop: every bot window keeps a taskbar button and an Alt-Tab entry, and Chromium **repositions bubbles onto the nearest real monitor** even when their parent window is off-screen. The one that bit: "Save password?" after every credential login (most runs) — a 462×683 popup parked on a monitor for the whole session. `BOT_CHROME_PREFS` (`src/browser-window.js`, passed as chrome-launcher `customConfig.prefs`) turns the password manager off in the temp profile; `prefs` is honoured by chrome-launcher, unlike `chromiumFlags`.

What works, part 2: a separate Win32 desktop — `BOT_DESKTOP=<name>`. `src/bot-desktop.js` makes `run-once.js` and `discord-bot.js` re-launch themselves once through `tools/desktop-launch.cs` (built on demand into `data/bin/` with the .NET Framework `csc.exe`) onto `WinSta0\<name>`; child processes inherit the desktop, so every Chrome follows with no change to the browser code. That desktop has no taskbar and is never the input desktop, so nothing on it can be seen or take focus. It is the same logon session and GPU — measured identical to an off-screen window on the normal desktop for rAF rate, `visibilityState`, WebGL renderer, `screen.*`, DPR and `screenX/Y`. The original process stays as a waiter (Task Scheduler still sees the task running, `>> run.log` still captures output) and the child tree is in a kill-on-close job. Fail-open: if the launcher can't build or start, the script runs on the normal desktop. Nothing on that desktop can be looked at directly — use the existing screenshot/HTML dumps, or `listDesktopWindows()` to see what windows exist; unset `BOT_DESKTOP` to debug visually.

Restarting `discord-bot.js`: `Stop-ScheduledTask ANADiscordBot` only ends `wscript.exe` — node keeps running (true before `BOT_DESKTOP` too). End every `node … discord-bot.js` process, then `Start-ScheduledTask ANADiscordBot`. With `BOT_DESKTOP` there are two such node processes (waiter → `desktop-launch.exe` → the real bot); ending the real bot or the launcher takes the rest down, ending only the waiter does not.

### Cookie pipeline health checks
Do NOT trust these as proof cookies are valid:
- `cookies.json` mtime is recent
- Cookie server `/health` returns recent `lastPushAge`
- Keep-alive logs "session alive"
- `discord-bot.js` process is running

**Verify instead**: check that `personal` and `_abck` cookies are present in `cookies.json`, check `state.json` `lastCoverage.checked > 0`, check that the user has an ANA tab open in Chrome. Read `docs/cookie-pipeline.md` before diagnosing cookie issues.

### Search form hidden fields
ANA's search form has visible text fields (`#departureAirportCode:field_pctext`) and hidden fields (`#departureAirportCode:field`) that store the actual IATA code. The autocomplete flow (type → ArrowDown → Enter) intermittently fails to update the hidden field. The bot force-sets hidden fields after autocomplete as a safety net (`session.js:searchDate`).

### Parser — miles extraction
ANA's results page renders the "Required mileage" DOM block only for the currently-selected flight. Per-flight miles are in inline `addFormatedRecommendation(...)` JS calls — one per flight, same DOM order, miles at argument index 5. Parse via `document.documentElement.outerHTML`, not `innerText`. The arg `'57,000'` has commas inside quotes, requiring a quote-aware arg splitter. See `parser.js:extractPerFlightMiles`.

### Session re-auth variants
ANA serves two login page variants: full login (`#accountNumber` + `#password`) and re-auth (only `#password`, AMC number pre-filled). `session.js:_loginWithCredentials` handles both. If the keep-alive or search hits the re-auth page, it fills only the password and clicks `#amcMemberLogin`.

### JSF quirks
ANA's site is built on JSF. Error pages have hidden ViewState inputs, so rate-limit detection should NOT use `inputCount === 0`. Use the absence of the expected `#departureAirportCode:field_pctext` form field instead.

## Chat agent

`@mention` the bot in the server (replying to one of its alerts counts) or DM it, and it answers in plain language: "watch SFO→TPE business Dec 10–15", "anything bookable to Tokyo under 60k?", "what changed overnight?". It only speaks when addressed.

- **`src/tracker-api.js`** — track / untrack / flights / status / recent events as plain functions over `routes.json`, `state.json` and `events.jsonl`. `/untrack` goes through it too, so both front ends remove things identically. Bad input throws `InputError`.
- **`src/agent.js`** — Gemini (`AGENT_MODEL`, default `gemini-3.5-flash-lite`, Google's lightest current model) with those functions as tools, over Google's Interactions API (`@google/genai`, `client.interactions.create`). It runs the request → tool → request loop itself and sends `store: false`, so the conversation lives only in the bot process. No Discord code.
- **`src/discord-chat.js`** — the Discord side: who may talk to it, mention stripping, reply-to-alert context, Confirm/Cancel buttons.

Rules that must survive edits:
- **Confirmation is enforced in code, not by the model.** A `track` adding more than 14 new dates, or an `untrack` of a whole route or more than 3 dates, is parked and shown as a button; only a click from the user who asked runs it (`resolveConfirmation`). Don't move that decision into the prompt.
- **History is append-only.** In stateless mode the API requires `thought` and `function_call` steps to be sent back exactly as received (they carry signatures). So steps are never edited, the system prompt is a constant, today's date and confirmation outcomes ride in the *user* message, and an old or long conversation is dropped whole, never trimmed. `test/agent.test.js` pins this.
- **The SDK's Interactions errors are not the exported `ApiError`.** Classify failures by the numeric `err.status`; an invalid key arrives as a 400 whose message mentions the API key (`describeApiFailure`). The SDK retries 429/5xx itself (`REQUEST_OPTIONS.maxRetries`).
- **Tool output is shaped for a small model.** Two mistakes seen live with `gemini-3.5-flash-lite` on raw data, both fixed in the output rather than the prompt: it read a UTC `lastCheck` as local time, and it bridged a gap when condensing 40 raw dates. So `localizeTimes` (agent.js) rewrites every UTC timestamp in a tool result to Pacific time with its age, and `describeTracked` (tracker-api.js) hands over routes with explicit counts and dates pre-collapsed into ranges. Keep new tool results in that spirit: small, already summarised, no unit or time-zone conversion left to the model.
- **Owner only.** `AGENT_USER_IDS`, else the owner of `DISCORD_GUILD_ID`; everyone else is ignored silently. It needs only the non-privileged `GuildMessages`/`DirectMessages` intents — Discord delivers message text for mentions and DMs without the Message Content intent.
- The agent can't search ANA or book; it reads what the search cycle stored and edits the watch list. `run_check_now` spawns the same `run-once.js` as `/check`.

Without `GEMINI_API_KEY` the bot runs as before and answers mentions with a setup hint. The tests need no key: they point the real SDK at a local server that plays back scripted Interactions responses.

## Routes data model

Per-date cabin tracking: each date on a route has its own cabin list. `/track` is additive (never destroys existing cabins). `/untrack` supports optional `cabin:` to remove just one class.

```json
{ "from": "HND", "to": "SFO", "dates": {
    "2026-05-01": ["premium-economy", "business"],
    "2026-07-05": ["premium-economy", "economy", "business"]
}}
```

Legacy format (dates as array + route-level `cabin` string) is auto-migrated on first load.

## Date input formats

`parseDateInput` in `routes.js` accepts:
- `2026-07-10` — single date
- `2026-07` — whole month (weekly expansion: 1st, 8th, 15th, 22nd, 29th)
- `2026-07-10~2026-07-13` — daily range (tilde)
- `2026-07-10 to 2026-07-13` — daily range (natural language)

Discord `/track` and `/untrack` also have an `until:` option for ranges.

## Notifications

Notifications fire **immediately per-flight** via an `onResult` callback from `runParallel`, not batched after the full search. GONE detection (confirmed flight disappeared) runs post-batch since it requires complete search data.

GONE detection uses a **miss grace period** (`GONE_GRACE_MISSES`): a flight is only removed after that many *consecutive* cycles where its combo was searched but the flight wasn't found. Without it, ANA's oscillating waitlist availability deletes a seat's state entry the instant it flickers out, so the seat re-alerts as brand-new when it returns — spamming the channel every cycle. State cleanup (`pruneStaleFlights`: orphaned + age-based) runs **before** `saveState` so deletions actually persist.

## Environment variables

Key `.env` settings (see `docs/cookie-pipeline.md` for full list):
- `ANA_USERNAME` / `ANA_PASSWORD` — AMC credentials for auto re-auth
- `DISCORD_BOT_TOKEN` / `DISCORD_GUILD_ID` — Discord bot
- `DISCORD_ALERT_CHANNEL_ID` / `DISCORD_STATUS_CHANNEL_ID`
- `GEMINI_API_KEY` — enables the chat agent (usage counts against that key's Gemini quota/billing). `AGENT_MODEL` (default `gemini-3.5-flash-lite`; e.g. `gemini-4-hydrogen` for a larger one), `AGENT_EFFORT` (optional thinking level: minimal|low|medium|high|xhigh; unset = model default), `AGENT_USER_IDS` (default: server owner). See "Chat agent".
- `MAX_SESSIONS=2` — parallel browser sessions
- `SKIP_KNOWN_AVAILABLE=false` — always re-search confirmed combos (default OFF so GONE detection works)
- `RECHECK_HOURS=4` — only relevant if SKIP_KNOWN_AVAILABLE=true
- `SKIP_MIXED_CABIN=true` — filter mixed-cabin layovers
- `MAX_LAYOVER_HOURS=30`
- `ALERT_WAITLIST=true`
- `GONE_GRACE_MISSES=3` — consecutive missed cycles before a flight is treated as gone and removed from state. Guards against ANA's waitlist availability oscillating on/off between cycles, which otherwise deletes + re-alerts the same seat as "new" every pull. Do not set to 1.
- `BOT_WINDOW_POSITION=-20000,0` — where bot Chrome windows go; unset keeps the legacy positions. See "Hiding bot windows".
- `BOT_DESKTOP=AnaBot` — run the bot (and all its Chrome windows) on a hidden Win32 desktop; unset = normal desktop. `discord-bot.js` needs a restart to pick it up. See "Hiding bot windows".
- `STALE_FLIGHT_DAYS=30` — prune cached flights not seen in this many days (backstop for combos that stop being searched, e.g. perpetually rate-limited)
