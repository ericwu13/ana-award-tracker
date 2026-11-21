/**
 * Scan-then-confirm planner (pure, no I/O — see test/scan-plan.test.js).
 *
 * Given every (route, date, cabin) task the routes ask for and a seats.aero
 * scan, decide which tasks the ANA scraper must still run this cycle. The goal
 * is fewer ANA searches (= fewer Akamai blocks) WITHOUT going blind on space
 * that only ANA can see.
 *
 * A task is sent to ANA when ANY of these hold (first match = reason):
 *   untrusted-cabin  the cabin isn't in SCAN_TRUST_CABINS — seats.aero can't
 *                    vouch for it (default: premium-economy, because ANA is
 *                    believed not to release PE award space to partner
 *                    programs — ⚠️ GUESS, verify by comparing a few cycles)
 *   scan-failed      seats.aero errored / wasn't asked for this window
 *   scan-hit         seats.aero shows space on a Star Alliance carrier
 *   tracked          state.flights already holds a seat for this combo — keep
 *                    re-checking so GONE detection, upgrades, miles changes
 *                    still work
 *   due              not ANA-checked for SCAN_FULL_RECHECK_HOURS (default 24).
 *                    Safety net: ANA's own-member inventory and waitlist are
 *                    invisible to seats.aero (⚠️ GUESS that the gap is real
 *                    and material — that's what this net is for). Capped at
 *                    SCAN_MAX_DUE_PER_CYCLE, oldest first, so the backlog is
 *                    spread out instead of hitting ANA all at once.
 * Otherwise the task is skipped with reason `scan-miss`.
 */

function taskKey(t) {
  return `${t.from}→${t.to}|${t.date}|${t.cabinName}`;
}

function planConfirmations(tasks, scan, state = {}, opts = {}) {
  const {
    trustCabins = ['economy', 'business'],
    fullRecheckHours = 24,
    maxDuePerCycle = 4,
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

  const decisions = [];
  const dueCandidates = [];
  const recheckMs = fullRecheckHours * 3600000;
  for (const t of tasks) {
    const sk = `${t.from}|${t.to}|${t.date}|${t.cabinKey}`;
    const d = { task: t, confirm: true, reason: null, hits: hits.get(sk) || [] };
    if (!trust.has(t.cabinKey)) d.reason = 'untrusted-cabin';
    else if (!scanned.has(sk)) d.reason = 'scan-failed';
    else if (d.hits.length > 0) d.reason = 'scan-hit';
    else if (tracked.has(taskKey(t))) d.reason = 'tracked';
    else {
      const last = lastChecked[taskKey(t)] || 0;
      if (now - last >= recheckMs) dueCandidates.push({ d, last });
      d.confirm = false;
      d.reason = 'scan-miss';
    }
    decisions.push(d);
  }

  dueCandidates.sort((a, b) => a.last - b.last);
  for (const { d } of dueCandidates.slice(0, Math.max(0, maxDuePerCycle))) {
    d.confirm = true;
    d.reason = 'due';
  }

  const counts = {};
  for (const d of decisions) counts[d.reason] = (counts[d.reason] || 0) + 1;
  return {
    confirm: decisions.filter(d => d.confirm),
    skip: decisions.filter(d => !d.confirm),
    counts,
  };
}

function strategyConfig() {
  return {
    strategy: process.env.SEARCH_STRATEGY || 'ana-only', // 'ana-only' | 'scan-then-confirm'
    trustCabins: (process.env.SCAN_TRUST_CABINS || 'economy,business').split(',').map(s => s.trim()).filter(Boolean),
    fullRecheckHours: parseFloat(process.env.SCAN_FULL_RECHECK_HOURS || '24'),
    maxDuePerCycle: parseInt(process.env.SCAN_MAX_DUE_PER_CYCLE || '4'),
  };
}

module.exports = { planConfirmations, strategyConfig, taskKey };
