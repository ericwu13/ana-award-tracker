/**
 * Search-source abstraction.
 *
 * A "source" is anything that can answer "is there award space for
 * (route, date, cabin)?". Every result a source emits is tagged with:
 *   - source:  which system produced it   ('ana' | 'seats.aero')
 *   - program: which mileage program the space is bookable with
 *              ('ana-amc' for the ANA site; seats.aero's own source id such as
 *               'aeroplan' / 'united' for seats.aero rows)
 *
 * Two roles:
 *   - scan sources   (seats.aero): cheap, wide, no browser, no Akamai. Their
 *                    hits are *candidates*, never alerted on directly.
 *   - confirm source (ana):        the existing puppeteer scraper. Only its
 *                    results feed state.flights / alerts / GONE detection.
 *
 * Contract (duck-typed, no class needed):
 *   {
 *     id:      string,                // 'seats.aero'
 *     role:    'scan' | 'confirm',
 *     enabled(): boolean,             // e.g. API key present
 *     search(tasks, ctx): Promise<{ entries: ScanEntry[], errors: string[] }>
 *   }
 *   task      = { from, to, date, cabinKey }      // cabinKey = routes.json key
 *   ScanEntry = { from, to, date, cabinKey, available, source, program,
 *                 miles, seats, airlines: string[], direct, updatedAt }
 */

const SOURCE_ANA = 'ana';
const PROGRAM_ANA = 'ana-amc';

/** Tag every result object in-place (and return it) with source + program. */
function tagResults(results, { source, program }) {
  for (const r of results || []) {
    if (!r || typeof r !== 'object') continue;
    if (r.source == null) r.source = source;
    if (r.program == null) r.program = program;
  }
  return results;
}

module.exports = { SOURCE_ANA, PROGRAM_ANA, tagResults };
