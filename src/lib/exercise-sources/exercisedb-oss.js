// Shared fetcher + row builder for ExerciseDB (open-source variant hosted
// at oss.exercisedb.dev). ~1,500 exercises with animated GIFs, AGPL-3.0,
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

/**
 * Fetch every exercise from oss.exercisedb.dev (with pagination + backoff)
 * and reduce each to the canonical LT row shape.
 *
 * @param {object} [opts]
 * @param {(url: string, init?: object) => Promise<any>} [opts.fetchFn]
 * @param {string} [opts.base] Override base URL (default oss.exercisedb.dev)
 * @param {Set<string>} [opts.existingIds] External IDs already in the DB;
 *   used to break the API's cursor-loop cleanly (the public host lies
 *   about hasNextPage past ~1500 rows).
 * @param {(msg: string) => void} [opts.log] Optional progress log.
 * @returns {Promise<Array>} normalized rows ready for INSERT.
 */
export async function fetchExerciseDbOssRows({
  fetchFn = fetch,
  base = DEFAULT_BASE,
  existingIds = new Set(),
  log,
} = {}) {
  const seen = new Set(existingIds);
  const rows = [];
  let cursor = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const body = await fetchPage(cursor, base, fetchFn, log);
    const data = body.data || [];
    let newOnThisPage = 0;
    for (const ex of data) {
      if (!ex?.name) continue;
      // Dedup by API's exerciseId — the public API's meta.hasNextPage
      // can loop after ~1500 items, so we detect it here.
      if (ex.exerciseId && seen.has(ex.exerciseId)) continue;
      if (ex.exerciseId) seen.add(ex.exerciseId);
      rows.push({
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
    if (page % 10 === 0) log?.(`page ${page + 1}, collected ${rows.length}`);
    if (data.length > 0 && newOnThisPage === 0) {
      log?.(`cursor loop detected at page ${page + 1} — stopping`);
      break;
    }
    if (!body.meta?.hasNextPage || !body.meta?.nextCursor) break;
    cursor = body.meta.nextCursor;
    await sleep(PAGE_DELAY_MS);
  }
  return rows;
}
