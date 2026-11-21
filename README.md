# ANA Award Tracker

Monitors award seat availability for configurable routes and dates and sends Discord alerts. Two independent sources:

- **ANA website** (puppeteer, your ANA login): ANA-operated flights as ANA members see them, including premium economy and waitlist.
- **seats.aero Partner API** (optional, plain HTTPS): saver seats across 20+ mileage programs (Aeroplan, United, LifeMiles, KrisFlyer, ...). It has no ANA Mileage Club source, so it cannot tell you what ANA releases to its own members.

## Architecture

```
ANADiscordBot (persistent, starts at login)
  ├── Discord slash commands (/track, /status, /flights, /check)
  ├── Cookie server (port 9444) ← receives cookies from Chrome extension
  └── Puppeteer keep-alive (every 25 min)

ANAAwardTracker (Task Scheduler, every 60 min)
  └── run-once.js → 2 parallel browser sessions → Discord alerts

ANASeatsAero (Task Scheduler, every 30 min, optional)
  └── run-seats.js → seats.aero cached search → saver filter → Discord alerts

Chrome Extension (content script on *.ana.co.jp)
  ├── Pushes cookies to bot every 5 min
  └── Reloads the ANA tab every 14 min to keep the session alive
```

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure `.env`

```bash
cp .env.example .env
```

Fill in:
- `ANA_USERNAME` — 10-digit AMC membership number
- `ANA_PASSWORD` — ANA web password
- `DISCORD_BOT_TOKEN` — Discord bot token
- `DISCORD_GUILD_ID` — Discord server ID
- `DISCORD_ALERT_CHANNEL_ID` — Channel for award alerts
- `DISCORD_STATUS_CHANNEL_ID` — Channel for status updates
- `ROUTES` — Routes to track (see format below)
- `SEATS_AERO_API_KEY` — optional seats.aero Partner API key (seats.aero Pro). Unset = seats.aero off

### 3. Install Chrome extension

1. Open `chrome://extensions/`
2. Enable **Developer mode**
3. Click **Load unpacked** → select the `cookie-exporter/` folder

### 4. Export initial cookies

1. Log in to ANA in Chrome: https://www.ana.co.jp/en/us/
2. The extension auto-pushes cookies (or click extension icon → Export Now)

### 5. Register Task Scheduler tasks

```powershell
# Search runner — every 60 minutes
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument 'run-check.vbs' -WorkingDirectory 'C:\path\to\ana-award-tracker'
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 60)
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 72) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'ANAAwardTracker' -Action $action -Trigger $trigger -Settings $settings

# Discord bot — persistent, starts at login
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument 'run-discord.vbs' -WorkingDirectory 'C:\path\to\ana-award-tracker'
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Days 365) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'ANADiscordBot' -Action $action -Trigger $trigger -Settings $settings

# seats.aero scan — every 30 minutes (optional; needs SEATS_AERO_API_KEY)
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument 'run-seats.vbs' -WorkingDirectory 'C:\path\to\ana-award-tracker'
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 30)
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'ANASeatsAero' -Action $action -Trigger $trigger -Settings $settings
```

Before relying on seats.aero alerts, run `node scripts/seats-aero-sample.js` once. It saves one real API response to `data/seats-aero-sample.json` (the key is never written) so the field mapping can be checked.

## Routes Configuration

In `.env`:
```
ROUTES=TPE-SFO:2026-04-05,2026-04-06,2026-10-04,2026-10-11;SFO-TPE:2026-11-04,2026-11-11
```

Format: `FROM-TO:date1,date2;FROM-TO:date3,date4`

Each date shows ±3 days via ANA's calendar comparison view. Space dates 7 days apart to cover a full month.

Or use Discord slash commands:
```
/track TPE SFO 2026-10        → adds whole month (auto-expands to weekly dates)
/track SFO TPE 2026-11-15     → adds specific date
/untrack SFO TPE 2026-12      → removes month + cached data
```

## Discord Commands

| Command | Description |
|---------|-------------|
| `/track <from> <to> <date>` | Add route+date (YYYY-MM-DD or YYYY-MM for whole month). Optional `source:` (both / ana / seats.aero), `programs:` (e.g. `aeroplan,united`), `max-miles:`, `direct-only:` |
| `/untrack <from> <to> [date]` | Remove route or date (also clears cached data) |
| `/routes` | List all tracked routes |
| `/status` | Availability summary table, plus seats.aero saver seats and API usage |
| `/flights <from> <to> <class> <date>` | Detailed flight list for a route |
| `/check` | Trigger immediate search |
| `/alerts clear` | Reset alert history |

## How Auth Works

ANA uses Akamai Bot Manager which detects browser automation (CDP). Automated login is blocked. Instead:

1. **You log in manually** in your regular Chrome browser
2. **Chrome extension** auto-exports cookies to the bot every 5 minutes
3. **Content script** reloads the ANA tab every 14 min to keep the session alive
4. **Bot uses cookies** to access the award search without logging in

When the session eventually expires, the bot sends a Discord alert asking you to log in again.

## Settings

| `.env` Variable | Default | Description |
|-----------------|---------|-------------|
| `MAX_SESSIONS` | `2` | Parallel browser sessions |
| `SKIP_MIXED_CABIN` | `true` | Skip mixed cabin results (e.g., Economy+Business) |
| `MAX_LAYOVER_HOURS` | `30` | Skip layovers longer than this |
| `ALERT_WAITLIST` | `true` | Alert on waitlisted flights |
| `COOKIE_SERVER_PORT` | `9444` | Port for cookie receiver |
| `SEATS_AERO_API_KEY` | — | Enables seats.aero tracking |
| `SEATS_AERO_INTERVAL_MIN` | `30` | Minimum minutes between seats.aero scans |
| `SEATS_AERO_DAILY_BUDGET` | `900` | API calls per UTC day; the interval stretches to stay under it (seats.aero allows ~1,000) |
| `SEATS_AERO_CAP_Y/W/J/F` | `40000/60000/85000/110000` | Price ceiling per cabin while learning saver prices |
| `SEATS_AERO_SAVER_MARGIN` | `0.10` | Alert when price ≤ 30-day low × (1 + margin) |
| `SEATS_AERO_LEARN_DAYS` | `7` | Days of price history before the cap is relaxed |
| `SEATS_AERO_HARD_CAP_MULT` | `1.5` | After learning, never alert above cap × this |
| `SEATS_AERO_GRACE_MISSES` | `3` | Scans a seat must be missing before it is forgotten |

## Files

```
src/
  session.js          — Parallel browser session manager
  index.js            — Search orchestrator
  parser.js           — ANA calendar + flight detail parser
  notifier.js         — Discord REST API notifications
  routes.js           — Route/state management
  discord-commands.js  — Slash command definitions
  cookie-server.js    — HTTP server for cookie ingestion

cookie-exporter/      — Chrome extension (MV3)
discord-bot.js        — Persistent Discord bot process
run-once.js           — Single search run (for Task Scheduler)
run-check.vbs         — Silent launcher for search
run-seats.js          — Single seats.aero scan (for Task Scheduler)
run-seats.vbs         — Silent launcher for the seats.aero scan
scripts/seats-aero-sample.js — Save one real seats.aero response for field checks
run-discord.vbs       — Silent launcher for Discord bot

data/                 — Runtime data (gitignored)
  cookies.json        — Current ANA cookies
  state.json          — Tracked flights + alert history
  routes.json         — Route configuration (managed by /track)
```
