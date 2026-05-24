import db from '../db.js';
import { logger } from '../logger.js';

/**
 * ExerciseDB — open-source variant hosted at oss.exercisedb.dev.
 * AGPL-3.0. No API key required. ~1,500 exercises with animated GIFs
 * served from static.exercisedb.dev.
 *
 * Endpoint:  GET https://oss.exercisedb.dev/api/v1/exercises?limit=25&cursor=XXX
 * Response:  { success, meta: { total, hasNextPage, nextCursor }, data: [...] }
 *
 * Fields per exercise:
 *   exerciseId (string), name, gifUrl,
 *   bodyParts[], equipments[], targetMuscles[], secondaryMuscles[],
 *   instructions[] (each prefixed "Step:N ")
 *
 * Note: public hosting is community-maintained with no SLA. Self-hostable
 * from the repo at github.com/ExerciseDB/exercisedb-api-oss. For heavy
 * traffic, point EXERCISEDB_OSS_URL at your own deployment.
 */

const DEFAULT_BASE = process.env.EXERCISEDB_OSS_URL || 'https://oss.exercisedb.dev';
const PAGE_SIZE = 25;
// Gentle pacing — Cloudflare's WAF in front of oss.exercisedb.dev throttles
// bursts of rapid requests. ~1 req/sec reliably stays under the limit from a
// residential IP; 500ms still trips roughly every 10 pages.
const PAGE_DELAY_MS = 1000;
const MAX_RETRIES   = 6;

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

/** Strip the "Step:N " prefix the API adds to each instruction line. */
function cleanInstruction(line) {
  return String(line || '').replace(/^Step:\d+\s*/i, '').trim();
}

async function fetchPage(cursor, base) {
  // API uses `after=<exerciseId>` for keyset pagination (NOT `cursor` — that
  // silently returns page 1 every time). meta.nextCursor in the response
  // is the value to feed back in.
  const url = `${base}/api/v1/exercises?limit=${PAGE_SIZE}${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`;
  let attempt = 0;
  while (true) {
    attempt++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { 'Accept': 'application/json', 'User-Agent': 'lifttrace/0.8.6' },
      });
      if (res.status === 429 || res.status === 503) {
        if (attempt > MAX_RETRIES) throw new Error(`exercisedb-oss rate-limited after ${MAX_RETRIES} retries`);
        // Honor Retry-After if present, else exponential backoff (2, 4, 8, 16, 32, 60s)
        const retryAfter = parseFloat(res.headers.get('retry-after'));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 60000)
          : Math.min(2000 * Math.pow(2, attempt - 1), 60000);
        logger.warn(`[exercisedb-oss] ${res.status} \u2014 backing off ${wait}ms (attempt ${attempt}/${MAX_RETRIES})`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw new Error(`exercisedb-oss returned ${res.status}`);
      const body = await res.json();
      if (!body?.success) throw new Error(`exercisedb-oss: ${JSON.stringify(body).slice(0, 200)}`);
      return body;
    } catch (e) {
      // Network-level failures also retry a couple of times
      if (attempt > MAX_RETRIES || /rate-limited/.test(e.message)) throw e;
      const wait = Math.min(2000 * Math.pow(2, attempt - 1), 30000);
      logger.warn(`[exercisedb-oss] network error "${e.message}" \u2014 retry in ${wait}ms`);
      await sleep(wait);
    } finally {
      clearTimeout(timer);
    }
  }
}

export async function seedFromExerciseDbOss({ base = DEFAULT_BASE } = {}) {
  // Pre-seed with any exerciseIds already in the DB from a prior import so
  // we don't re-insert them and we still detect cursor-loops cleanly.
  const existing = db.prepare(
    `SELECT external_id FROM exercises WHERE source = 'exercisedb-oss' AND external_id IS NOT NULL`
  ).all();
  const seenIds = new Set(existing.map(r => r.external_id));

  const insert = db.prepare(
    `INSERT OR IGNORE INTO exercises
     (name, category, primary_muscles, secondary_muscles, equipment, instructions, gif_url, external_id, source, is_global)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'exercisedb-oss', 1)`
  );

  let cursor = null;
  let count = 0;
  let processed = 0;
  const maxPages = 200;  // safety: ~1500 / 25 = 60; cap at 200 pages

  for (let page = 0; page < maxPages; page++) {
    const body = await fetchPage(cursor, base);
    const data = body.data || [];

    let newOnThisPage = 0;
    for (const ex of data) {
      if (!ex?.name) continue;
      // Dedup by API's exerciseId. The public API's meta.total and
      // hasNextPage can lie (cursor loops after ~1500 items), so we detect
      // the loop here and stop cleanly.
      if (ex.exerciseId && seenIds.has(ex.exerciseId)) continue;
      if (ex.exerciseId) seenIds.add(ex.exerciseId);

      const name = titleCase(ex.name);
      const category = mapCategory((ex.bodyParts || [])[0]);
      const primary = (ex.targetMuscles || []).map(titleCase);
      const secondary = (ex.secondaryMuscles || []).map(titleCase);
      const equipment = (ex.equipments || []).map(titleCase);
      const instructions = (ex.instructions || []).map(cleanInstruction).filter(Boolean).join('\n\n') || null;

      const result = insert.run(
        name, category,
        JSON.stringify(primary),
        JSON.stringify(secondary),
        JSON.stringify(equipment),
        instructions,
        ex.gifUrl || null,
        ex.exerciseId || null,
      );
      processed++;
      if (result.changes > 0) { count++; newOnThisPage++; }
    }

    // Progress log every ~10 pages so user can see it working in container logs
    if (page % 10 === 0) logger.info(`[exercisedb-oss] page ${page + 1}, inserted ${count} so far`);

    // Cursor-loop detected: every row on this page was one we'd already seen.
    // Stop — no new data to gain by paginating further.
    if (data.length > 0 && newOnThisPage === 0) {
      logger.info(`[exercisedb-oss] cursor loop detected at page ${page + 1} \u2014 stopping`);
      break;
    }

    if (!body.meta?.hasNextPage || !body.meta?.nextCursor) break;
    cursor = body.meta.nextCursor;
    await sleep(PAGE_DELAY_MS);
  }

  logger.info(`[exercisedb-oss] done: processed ${processed}, inserted ${count}`);
  return count;
}
