/**
 * Scan-then-confirm planner (pure, no I/O — see test/scan-plan.test.js).
 *
 * seats.aero has NO ANA Mileage Club source: it only sees what Star Alliance
 * releases to partner programs (Aeroplan, United, ...). ANA gives its own
 * members more space (plus waitlist and premium economy) than it releases to
 * partners, so "seats.aero saw nothing" does NOT mean "ANA has nothing".
 * The scan therefore PRIORITISES ANA searches by default — it never drops one:
 * hits go to the front of the queue so they are checked before Akamai starts
 * throttling a session.
 *
 * Each task gets a reason (first match wins):
 *   untrusted-cabin  cabin not in SCAN_TRUST_CABINS — scan says nothing about it
 *   scan-failed      seats.aero errored / wasn't asked for this window
 *   scan-hit         seats.aero shows partner space on a Star Alliance carrier
 *                    → priority: searched first
 *   tracked          state.flights already holds a seat for this combo
 *   scan-miss        none of the above. Still searched, UNLESS the opt-in
 *                    SCAN_MISS_RECHECK_HOURS > 0 and ANA checked it more
 *                    recently than that → skipped this cycle (trades some risk
 *                    of missing ANA-member-only space for fewer ANA requests).
 */

function taskKey(t) {
  return `${t.from}→${t.to}|${t.date}|${t.cabinName}`;
}

function planConfirmations(tasks, scan, state = {}, opts = {}) {
  const {
    trustCabins = ['economy', 'business'],
    missRecheckHours = 0, // 0 = never skip (default)
    now = Date.now(),
  } = opts;
  const trust = new Set(trustCabins);
  const lastChecked = state.lastChecked || {};

  const scanned = new Set();
  for (const g of scan?.scannedGroups || []) {
    for (const d of g.dates) scanned.add(`${g.from}|${g.to}|${d}|${g.cabinKey}`);
  }
  const hits = new Map(); // from|to|date|cabinKey → [ScanEntry]
  for (const e of scan?.entries || []) {
    if (!e.available) continue;
    const k = `${e.from}|${e.to}|${e.date}|${e.cabinKey}`;
    if (!hits.has(k)) hits.set(k, []);
    hits.get(k).push(e);
  }
  const tracked = new Set();
  for (const f of Object.values(state.flights || {})) {
    if (f.route && f.date && f.searchedCabin) tracked.add(`${f.route}|${f.date}|${f.searchedCabin}`);
  }

  const missMs = missRecheckHours * 3600000;
  const decisions = [];
  for (const t of tasks) {
    const sk = `${t.from}|${t.to}|${t.date}|${t.cabinKey}`;
    const d = { task: t, confirm: true, priority: false, reason: null, hits: hits.get(sk) || [] };
    if (!trust.has(t.cabinKey)) d.reason = 'untrusted-cabin';
    else if (!scanned.has(sk)) d.reason = 'scan-failed';
    else if (d.hits.length > 0) { d.reason = 'scan-hit'; d.priority = true; }
    else if (tracked.has(taskKey(t))) d.reason = 'tracked';
    else {
      d.reason = 'scan-miss';
      const last = lastChecked[taskKey(t)] || 0;
      if (missMs > 0 && now - last < missMs) d.confirm = false;
    }
    decisions.push(d);
  }

  const counts = {};
  for (const d of decisions) {
    const k = d.confirm ? d.reason : `${d.reason}-skipped`;
    counts[k] = (counts[k] || 0) + 1;
  }
  return {
    confirm: decisions.filter(d => d.confirm),
    skip: decisions.filter(d => !d.confirm),
    counts,
  };
}

/**
 * The lastChecked map runParallel sorts by (oldest first). Returns a copy with
 * priority tasks forced to the very front; the real state.lastChecked is
 * untouched.
 */
function priorityLastChecked(lastChecked, plan) {
  const out = { ...(lastChecked || {}) };
  for (const d of plan.confirm) if (d.priority) out[taskKey(d.task)] = -1;
  return out;
}

function strategyConfig() {
  return {
    strategy: process.env.SEARCH_STRATEGY || 'ana-only', // 'ana-only' | 'scan-then-confirm'
    trustCabins: (process.env.SCAN_TRUST_CABINS || 'economy,business').split(',').map(s => s.trim()).filter(Boolean),
    missRecheckHours: parseFloat(process.env.SCAN_MISS_RECHECK_HOURS || '0'),
  };
}

module.exports = { planConfirmations, priorityLastChecked, strategyConfig, taskKey };
