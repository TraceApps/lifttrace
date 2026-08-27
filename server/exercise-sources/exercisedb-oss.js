import db from '../db.js';
import { logger } from '../logger.js';
import { fetchExerciseDbOssRows } from '../../src/lib/exercise-sources/exercisedb-oss.js';

// Env override for self-hosters who run their own oss.exercisedb.dev
// mirror. Falls through to the public host inside the shared module if
// unset.
const BASE = process.env.EXERCISEDB_OSS_URL || undefined;

export async function seedFromExerciseDbOss() {
  // Pre-seed the shared fetcher's dedup set with LIVE exerciseIds so
  // re-import doesn't loop. Soft-deleted rows are intentionally
  // excluded — those need to resurrect via the (source, external_id)
  // check below to preserve their id, which past workout_log JSON
  // blobs point at (#49).
  const liveExtIds = new Set(
    db.prepare(`SELECT external_id FROM exercises
                WHERE source = 'exercisedb-oss' AND external_id IS NOT NULL AND deleted_at IS NULL`)
      .all().map(r => r.external_id)
  );
  const resurrectByExtId = db.prepare(
    `UPDATE exercises
       SET deleted_at = NULL, updated_at = datetime('now')
     WHERE source = 'exercisedb-oss' AND external_id = ? AND deleted_at IS NOT NULL`
  );

  const rows = await fetchExerciseDbOssRows({
    base: BASE,
    existingIds: liveExtIds,
    log: (msg) => logger.info(`[exercisedb-oss] ${msg}`),
  });

  const insert = db.prepare(
    `INSERT OR IGNORE INTO exercises
     (name, category, primary_muscles, secondary_muscles, equipment,
      instructions, gif_url, external_id, source, is_global)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'exercisedb-oss', 1)`
  );

  let count = 0, resurrected = 0;
  for (const r of rows) {
    if (r.external_id != null) {
      const rs = resurrectByExtId.run(String(r.external_id));
      if (rs.changes > 0) { resurrected++; continue; }
    }
    const res = insert.run(
      r.name, r.category,
      JSON.stringify(r.primary_muscles),
      JSON.stringify(r.secondary_muscles),
      JSON.stringify(r.equipment),
      r.instructions,
      r.gif_url,
      r.external_id,
    );
    if (res.changes > 0) count++;
  }
  logger.info(`[exercisedb-oss] done: processed ${rows.length}, inserted ${count}, resurrected ${resurrected}`);
  return count + resurrected;
}
