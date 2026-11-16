/**
 * Event history — data/events.jsonl, one JSON object per line.
 *
 * state.json only holds what is available *now*; once a seat is gone its entry
 * is deleted, and the run logs are unstructured text with no timestamps. This
 * append-only log is what lets "what changed overnight?" be answered.
 *
 * Written by the search cycle (index.js) at the same points it alerts:
 *   new           a seat seen for the first time
 *   upgraded      waitlist → confirmed (only when the alert fires, so ANA's
 *                 waitlist flip-flopping doesn't flood the log)
 *   gone          a confirmed seat disappeared (after the GONE grace period)
 *   miles_changed the mileage cost of a known seat changed
 *
 * Recording never throws: losing a history line must not break a search run.
 */
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./routes');

const EVENTS_FILE = path.join(DATA_DIR, 'events.jsonl');

/**
 * @param {'new'|'upgraded'|'gone'|'miles_changed'} type
 * @param {object} flight  a state.flights entry or equivalent fields
 * @param {object} [extra] e.g. { prevMiles }
 */
function recordEvent(type, flight, extra = {}) {
  try {
    const event = {
      ts: new Date().toISOString(),
      type,
      route: flight.route,
      date: flight.date,
      flightNumber: flight.flightNumber || null,
      cabin: flight.cabinDesc || flight.searchedCabin || null,
      status: flight.status || null,
      miles: flight.miles ?? null,
      taxUsd: flight.taxUsd ?? null,
      ...extra,
    };
    fs.mkdirSync(path.dirname(EVENTS_FILE), { recursive: true });
    fs.appendFileSync(EVENTS_FILE, JSON.stringify(event) + '\n');
  } catch (e) {
    console.log(`[Events] Could not record ${type} event: ${e.message}`);
  }
}

/**
 * Read events, newest first.
 * @param {{ sinceHours?: number, limit?: number, types?: string[], route?: string, now?: number }} [opts]
 * @returns {{ events: object[], total: number }} total = matches before `limit` was applied
 */
function readEvents({ sinceHours = 24, limit = 50, types = null, route = null, now = Date.now() } = {}) {
  let lines;
  try {
    lines = fs.readFileSync(EVENTS_FILE, 'utf8').split('\n');
  } catch {
    return { events: [], total: 0 };
  }
  const cutoff = now - sinceHours * 60 * 60 * 1000;
  const matches = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; } // a torn line from a killed run
    if (new Date(ev.ts).getTime() < cutoff) continue;
    if (types && !types.includes(ev.type)) continue;
    if (route && ev.route !== route) continue;
    matches.push(ev);
  }
  matches.reverse();
  return { events: matches.slice(0, limit), total: matches.length };
}

module.exports = { recordEvent, readEvents, EVENTS_FILE };
