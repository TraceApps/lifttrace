// Shared fetcher + row builder for ExerciseDB (open-source variant hosted
// at oss.exercisedb.dev). ~1,300 exercises with animated GIFs, AGPL-3.0,
// no API key required.
//
// Isomorphic — see wger.js for the fetchFn convention. The wrapper still
// handles paging + retry + rate-limit backoff inside this module so both
// server and native path get the same behaviour.

const DEFAULT_BASE = 'https://oss.exercisedb.dev';
const PAGE_SIZE = 25;
// Gentle pacing — Cloudflare's WAF in front of oss.exercisedb.dev throttles
// bursts; ~1 req/sec reliably stays under the limit.
const PAGE_DELAY_MS = 1000;
const MAX_RETRIES = 6;
const MAX_PAGES = 200;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function mapCategory(bodyPart) {
  const m = {
    'back': 'back', 'cardio': 'cardio', 'chest': 'chest',
    'lower arms': 'arms', 'lower legs': 'legs',
    'neck': 'shoulders', 'shoulders': 'shoulders',
    'upper arms': 'arms', 'upper legs': 'legs', 'waist': 'core',
  };
  return m[(bodyPart || '').toLowerCase()] || 'other';
}

function titleCase(s) {
  if (!s) return s;
  return s.split(' ').map(w => w[0] ? w[0].toUpperCase() + w.slice(1) : w).join(' ');
}

function cleanInstruction(line) {
  return String(line || '').replace(/^Step:\d+\s*/i, '').trim();
}

async function fetchPage(cursor, base, fetchFn, log) {
  // API uses `after=<exerciseId>` for keyset pagination (NOT `cursor` — that
  // silently returns page 1 every time). meta.nextCursor is the value to
  // feed back in.
  const url = `${base}/api/v1/exercises?limit=${PAGE_SIZE}${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`;
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      const res = await fetchFn(url, { headers: { 'Accept': 'application/json' } });
      if (res.status === 429 || res.status === 503) {
        if (attempt > MAX_RETRIES) throw new Error(`exercisedb-oss rate-limited after ${MAX_RETRIES} retries`);
        const retryAfter = parseFloat(res.headers?.get?.('retry-after'));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 60000)
          : Math.min(2000 * Math.pow(2, attempt - 1), 60000);
        log?.(`${res.status} — backing off ${wait}ms (attempt ${attempt}/${MAX_RETRIES})`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw new Error(`exercisedb-oss returned ${res.status}`);
      const body = await res.json();
      if (!body?.success) throw new Error(`exercisedb-oss: ${JSON.stringify(body).slice(0, 200)}`);
      return body;
    } catch (e) {
      if (attempt > MAX_RETRIES || /rate-limited/.test(e.message)) throw e;
      const wait = Math.min(2000 * Math.pow(2, attempt - 1), 30000);
      log?.(`network error "${e.message}" — retry in ${wait}ms`);
      await sleep(wait);
    }
  }
}

// ExerciseDB lists 195 names two to four times, and the GIF of 176 of those
// copies is gone from its CDN, so they showed as broken images (#155).
// The GIF host answers about one at a time (5 a second), so more at once
// buys nothing: about 400 checks add 80 to 110 seconds to an import.
const GIF_CHECKS_AT_ONCE = 4;

async function gifIsGone(url, fetchFn) {
  try {
    const res = await fetchFn(url, { method: 'HEAD' });
    return res.status === 404 || res.status === 410;
  } catch {
    return false; // can't tell: keep it
  }
}

/**
 * The external ids of copies to leave out: a repeated name whose GIF is gone,
 * while another copy of that name remains. Only repeated names are checked.
 *
 * @param {Array} rows normalized rows (name, gif_url, external_id)
 * @param {(url: string) => Promise<boolean>} isGone
 * @returns {Promise<Set<string>>}
 */
export async function brokenDuplicateIds(rows, isGone) {
  const byName = new Map();
  for (const r of rows) {
    const k = String(r.name || '').toLowerCase();
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(r);
  }
  const groups = [...byName.values()].filter(g => g.length > 1);
  const toCheck = groups.flat().filter(r => r.gif_url && r.external_id != null);
  const gone = new Set();
  let next = 0;
  const worker = async () => {
    while (next < toCheck.length) {
      const r = toCheck[next++];
      if (await isGone(r.gif_url)) gone.add(String(r.external_id));
    }
  };
  await Promise.all(Array.from({ length: GIF_CHECKS_AT_ONCE }, worker));
  const broken = new Set();
  for (const g of groups) {
    const dead = g.filter(r => r.external_id != null && gone.has(String(r.external_id)));
    if (dead.length < g.length) for (const r of dead) broken.add(String(r.external_id));
  }
  return broken;
}

/**
 * Library ids still in use, so a broken copy is kept rather than cleared:
 * every exercise_id in workouts, templates and prescriptions, and every
 * number in a setting (favorites, per-exercise rest and load types).
 * Counting too many only keeps a copy.
 *
 * @param {{ exerciseBlobs?: string[], settingValues?: string[] }} sources
 * @returns {Set<number>}
 */
export function referencedExerciseIds({ exerciseBlobs = [], settingValues = [] } = {}) {
  const ids = new Set();
  const num = (v) => {
    const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN);
    if (Number.isInteger(n)) ids.add(n);
  };
  const parse = (b) => { try { return JSON.parse(b); } catch { return b; } };
  for (const b of exerciseBlobs) {
    const list = b == null ? null : parse(b);
    if (!Array.isArray(list)) continue;
    for (const ex of list) if (ex && typeof ex === 'object') num(ex.exercise_id);
  }
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { num(k); walk(x); }
    else num(v);
  };
  for (const b of settingValues) if (b != null) walk(parse(b));
  return ids;
}

/**
 * Fetch every exercise from oss.exercisedb.dev (with pagination + backoff)
 * and reduce each to the canonical LT row shape.
 *
 * @param {object} [opts]
 * @param {(url: string, init?: object) => Promise<any>} [opts.fetchFn]
 * @param {string} [opts.base] Override base URL (default oss.exercisedb.dev)
 * @param {Set<string>} [opts.existingIds] External IDs already in the DB,
 *   left out of `rows`. The whole catalog is still read, so a repeated name
 *   is judged against every copy.
 * @param {(msg: string) => void} [opts.log] Optional progress log.
 * @returns {Promise<{rows: Array, brokenIds: Set<string>}>} new rows ready
 *   for INSERT, and the copies to leave out (and clear where unused).
 */
export async function fetchExerciseDbOssRows({
  fetchFn = fetch,
  base = DEFAULT_BASE,
  existingIds = new Set(),
  log,
} = {}) {
  // This run's ids only: the public API's meta.hasNextPage can loop after
  // ~1500 items, and a page with nothing new means it has.
  const seen = new Set();
  const all = [];
  let cursor = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const body = await fetchPage(cursor, base, fetchFn, log);
    const data = body.data || [];
    let newOnThisPage = 0;
    for (const ex of data) {
      if (!ex?.name) continue;
      if (ex.exerciseId && seen.has(ex.exerciseId)) continue;
      if (ex.exerciseId) seen.add(ex.exerciseId);
      all.push({
        name: titleCase(ex.name),
        category: mapCategory((ex.bodyParts || [])[0]),
        primary_muscles: (ex.targetMuscles || []).map(titleCase),
        secondary_muscles: (ex.secondaryMuscles || []).map(titleCase),
        equipment: (ex.equipments || []).map(titleCase),
        instructions: (ex.instructions || []).map(cleanInstruction).filter(Boolean).join('\n\n') || null,
        img_url: null,
        gif_url: ex.gifUrl || null,
        video_url: null,
        external_id: ex.exerciseId || null,
      });
      newOnThisPage++;
    }
    if (page % 10 === 0) log?.(`page ${page + 1}, collected ${all.length}`);
    if (data.length > 0 && newOnThisPage === 0) {
      log?.(`cursor loop detected at page ${page + 1}, stopping`);
      break;
    }
    if (!body.meta?.hasNextPage || !body.meta?.nextCursor) break;
    cursor = body.meta.nextCursor;
    await sleep(PAGE_DELAY_MS);
  }
  const brokenIds = await brokenDuplicateIds(all, (url) => gifIsGone(url, fetchFn));
  if (brokenIds.size) log?.(`${brokenIds.size} repeated exercises with a missing GIF left out`);
  const known = new Set([...existingIds].map(String));
  const rows = all.filter(r => r.external_id == null
    || (!known.has(String(r.external_id)) && !brokenIds.has(String(r.external_id))));
  return { rows, brokenIds };
}
