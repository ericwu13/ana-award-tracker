/**
 * Prunes files the tracker writes forever and never reads back:
 *   data/logs/run-YYYY-MM-DD.log   — one per day from run-check.vbs
 *   data/form-error-*.{html,png}   — up to 3 full-page captures per cycle
 *
 * LOG_RETENTION_DAYS (default 30) — delete these once older than N days by
 * mtime. 0 = keep everything (old behaviour). Only these exact name patterns
 * are ever touched; state, routes, cookies and anything else are never deleted.
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DEFAULT_RETENTION_DAYS = 30;

const TARGETS = [
  { dir: ['logs'], re: /^run-\d{4}-\d{2}-\d{2}\.log$/ },
  { dir: [], re: /^form-error-.+\.(?:html|png)$/ },
];

function retentionDays(env = process.env) {
  const raw = env.LOG_RETENTION_DAYS;
  if (raw == null || String(raw).trim() === '') return DEFAULT_RETENTION_DAYS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_RETENTION_DAYS;
}

/**
 * @returns {{ removed: string[], bytes: number }}
 */
function pruneOldFiles({ dataDir = DATA_DIR, env = process.env, now = Date.now() } = {}) {
  const result = { removed: [], bytes: 0 };
  const days = retentionDays(env);
  if (days === 0) return result;
  const cutoff = now - days * 24 * 60 * 60 * 1000;

  for (const { dir, re } of TARGETS) {
    const base = path.join(dataDir, ...dir);
    let names;
    try { names = fs.readdirSync(base); } catch (_) { continue; }
    for (const name of names) {
      if (!re.test(name)) continue;
      const file = path.join(base, name);
      try {
        const st = fs.statSync(file);
        if (!st.isFile() || st.mtimeMs >= cutoff) continue;
        fs.unlinkSync(file);
        result.removed.push(path.join(...dir, name));
        result.bytes += st.size;
      } catch (_) { /* locked / vanished — try again next cycle */ }
    }
  }
  return result;
}

module.exports = { pruneOldFiles, retentionDays, DEFAULT_RETENTION_DAYS };
