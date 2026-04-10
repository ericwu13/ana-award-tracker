# Cookie Refresh Pipeline

This document explains how the bot keeps ANA session cookies fresh without manual intervention, and what to do when something needs your attention.

## Why this exists

ANA's award booking system is protected by Akamai Bot Manager which detects browser automation (CDP). Automated login from puppeteer is blocked. The bot works around this by:

1. Letting **you** log in once via your regular Chrome browser
2. Using a Chrome extension to **export the session cookies** to the bot
3. Using puppeteer with those cookies to **search only** (Akamai doesn't block search submissions as aggressively as login)

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  YOUR CHROME BROWSER                                                │
│  (logged into ANA, tab open in background)                          │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  ANA Cookie Exporter (Chrome extension)                     │    │
│  │                                                             │    │
│  │  Content script (runs on *.ana.co.jp pages)                 │    │
│  │   • Pushes cookies every 5 min                              │    │
│  │   • Reloads ANA page every 14 min (keeps session alive)     │    │
│  │   • Web Lock prevents tab freezing in background            │    │
│  │                                                             │    │
│  │  Background service worker                                  │    │
│  │   • chrome.alarms backup push every 10 min                  │    │
│  │     (unreliable in MV3 — content script is primary)         │    │
│  └─────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────┬───────────────────────────┘
                                          │ POST cookies
                                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│  DISCORD BOT PROCESS                                                │
│  (persistent — Windows Task Scheduler at login)                     │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  Cookie server (port 9444)                                  │    │
│  │   • Receives cookies via HTTP POST                          │    │
│  │   • Validates required cookies (personal, _abck)            │    │
│  │   • Saves to data/cookies.json                              │    │
│  │   • Clears stale flag when cookies arrive                   │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  Puppeteer keep-alive (every 25 min)                        │    │
│  │   1. Launches temporary Chrome (puppeteer-real-browser)     │    │
│  │   2. Loads cookies from data/cookies.json                   │    │
│  │   3. Navigates ana.co.jp/0771 → aswbe-i.ana.co.jp           │    │
│  │   4a. Lands on search form → save fresh cookies (✅)         │    │
│  │   4b. Lands on re-auth page → enter password automatically   │    │
│  │   4c. Akamai blocks → set data/session-stale.flag (⏸️)       │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  Discord slash commands (/track, /status, /check, etc.)     │    │
│  └─────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────┬───────────────────────────┘
                                          │
                                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│  SEARCH TASK                                                        │
│  (Windows Task Scheduler, every 60 min)                             │
│                                                                     │
│  run-once.js → src/index.js                                         │
│   1. Reads data/cookies.json                                        │
│   2. Checks data/session-stale.flag — skip if set                   │
│   3. Cleans up expired/unbookable dates                             │
│   4. Skips date+cabin combos already confirmed within RECHECK_HOURS │
│   5. Launches 2 puppeteer sessions in parallel                      │
│   6. Sends Discord alerts for new availability or GONE flights      │
│   7. Reports coverage stats                                         │
└─────────────────────────────────────────────────────────────────────┘
```

## Files

| File | Purpose |
|---|---|
| `data/cookies.json` | Current ANA cookies (written by extension and keep-alive) |
| `data/session-stale.flag` | When present, all retries stop until cleared |
| `data/state.json` | Tracked flights, last check time, coverage stats |
| `data/routes.json` | Routes/dates being tracked (managed by `/track`/`/untrack`) |

## When YOU need to do something manually

**Only one scenario:** Discord sends an alert like:

> ⚠️ ANA session issue: Re-auth failed — log in to ANA in Chrome. Bot will stop retrying until you do.

**What it means:** The puppeteer keep-alive tried to refresh the session, hit ANA's re-auth page (which asks for the password), submitted credentials, and Akamai blocked the submission. The bot has set the **stale flag** which stops ALL retries (search task, keep-alive, etc.) to avoid hammering ANA.

**What to do:**

1. Open ANA in your regular Chrome browser: <https://www.ana.co.jp/en/us/>
2. Log in manually (Akamai trusts your real browser fingerprint)
3. The Cookie Exporter extension auto-pushes the new cookies within ~5 minutes
4. The cookie server receives them, validates `personal` is present, and **automatically clears the stale flag**
5. The bot resumes on the next scheduled cycle (within 60 min)

That's it. No restart needed.

## Setup requirements (one-time)

- Chrome installed
- Cookie Exporter extension loaded from `cookie-exporter/` folder via `chrome://extensions/`
- ANA Mileage Club account credentials in `.env`
- ANA tab logged in once

## Conditions for fully hands-free operation

- Chrome is open (an ANA tab in the background is helpful but not strictly required — alarm-based push works without)
- You're logged into ANA
- ANA hasn't expired your `personal` cookie (rare — happens maybe weekly to monthly)

In practice: log in once, leave Chrome with an ANA tab open somewhere, and the bot runs for days or weeks until ANA decides to invalidate the long-lived `personal` cookie.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Discord alert: "Re-auth failed" | ANA wants password re-auth, Akamai blocked it | Log in to ANA in Chrome |
| Discord alert: "Blocked by ANA/Akamai" | IP-level rate limit | Wait a few hours, then re-login in Chrome |
| Coverage shows "0 checked, all rate-limited" | ANA throttle | Wait for it to lift naturally (hours) |
| Cookie file age >1 hour, no extension push | Chrome closed or extension disabled | Reopen Chrome, reload extension |
| `/status` shows fewer flights than tracking line | Stale orphaned entries (fixed automatically next cycle) | Wait one cycle, or run `/check` |

## Configuration knobs

In `.env`:

```
RECHECK_HOURS=4               # Re-check confirmed flights after this many hours
MIN_BOOK_LEAD_DAYS=4          # Skip dates within ANA's 96-hour booking deadline
SKIP_KNOWN_AVAILABLE=false    # Re-check confirmed combos every cycle (default). Set =true to reduce ANA load at cost of delayed GONE detection.
SKIP_MIXED_CABIN=true         # Don't alert mixed-cabin layovers
ALERT_WAITLIST=true           # Alert on waitlisted flights
MAX_LAYOVER_HOURS=30          # Skip flights with longer layovers
MAX_SESSIONS=2                # Parallel browser sessions
COOKIE_SERVER_PORT=9444       # Port the cookie server listens on
```
