# ANA Award Tracker — Claude Code Instructions

## Architecture

Two independent processes share `data/cookies.json` and `data/state.json`:

- **`discord-bot.js`** — persistent (Task Scheduler at login). Runs Discord slash commands, cookie server (port 9444), and puppeteer keep-alive (every 25 min). Changes to its in-memory code require a process restart.
- **`run-once.js`** → `src/index.js` — spawned fresh every 60 min by Task Scheduler. Single search cycle, exits. Always loads the latest code from disk — no restart needed for code changes to take effect.

The Chrome extension (`cookie-exporter/`) auto-pushes cookies every 5-10 min from the user's real Chrome browser. Its content script (`content.js`) reloads the ANA tab every 14 min to keep the server-side session alive. Full pipeline documented in `docs/cookie-pipeline.md`.

## Running tests

```bash
node test/routes.test.js    # 55 tests — routes data model, per-date cabins, date parsing
node test/parser.test.js    # 27 tests — per-flight miles extraction from ANA HTML
```

No test framework — uses built-in `assert`. Exits with code 1 on failure.

## Key data files

| File | Format | Written by |
|---|---|---|
| `data/routes.json` | `{ routes: [{ from, to, dates: { 'YYYY-MM-DD': ['premium-economy','business'] } }] }` | Discord commands, cleanup |
| `data/state.json` | `{ flights: { key: flight }, lastChecked: { combo: timestamp }, lastCoverage: {...} }` | run-once.js search cycle |
| `data/cookies.json` | Array of cookie objects | Chrome extension + keep-alive |
| `data/session-stale.flag` | Presence = all retries halted | keep-alive on Akamai block |

## Critical technical details

### Akamai bot detection
ANA uses Akamai Bot Manager. The "heavy traffic" / "request cannot be accepted" page is bot detection, NOT rate limiting. Automated login via puppeteer is blocked. Login must happen in the user's real Chrome browser. The bot only uses puppeteer for searches (less aggressively blocked).

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

## Environment variables

Key `.env` settings (see `docs/cookie-pipeline.md` for full list):
- `ANA_USERNAME` / `ANA_PASSWORD` — AMC credentials for auto re-auth
- `DISCORD_BOT_TOKEN` / `DISCORD_GUILD_ID` — Discord bot
- `DISCORD_ALERT_CHANNEL_ID` / `DISCORD_STATUS_CHANNEL_ID`
- `MAX_SESSIONS=2` — parallel browser sessions
- `SKIP_KNOWN_AVAILABLE=false` — always re-search confirmed combos (default OFF so GONE detection works)
- `RECHECK_HOURS=4` — only relevant if SKIP_KNOWN_AVAILABLE=true
- `SKIP_MIXED_CABIN=true` — filter mixed-cabin layovers
- `MAX_LAYOVER_HOURS=30`
- `ALERT_WAITLIST=true`
