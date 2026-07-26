import db from '../db.js';
import { logger } from '../logger.js';
import { fetchExerciseDbOssRows } from '../../src/lib/exercise-sources/exercisedb-oss.js';

// Env override for self-hosters who run their own oss.exercisedb.dev
// mirror. Falls through to the public host inside the shared module if
// unset.
const BASE = process.env.EXERCISEDB_OSS_URL || undefined;

export async function seedFromExerciseDbOss() {
  // Pre-seed the shared fetcher's dedup set with any exerciseIds already
  // in the DB so re-import doesn't loop.
  const existing = db.prepare(
    `SELECT external_id FROM exercises WHERE source = 'exercisedb-oss' AND external_id IS NOT NULL`
  ).all();
  const existingIds = new Set(existing.map(r => r.external_id));

  const rows = await fetchExerciseDbOssRows({
    base: BASE,
    existingIds,
    log: (msg) => logger.info(`[exercisedb-oss] ${msg}`),
  });

  const insert = db.prepare(
    `INSERT OR IGNORE INTO exercises
     (name, category, primary_muscles, secondary_muscles, equipment,
      instructions, gif_url, external_id, source, is_global)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'exercisedb-oss', 1)`
  );

  let count = 0;
  for (const r of rows) {
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
  logger.info(`[exercisedb-oss] done: processed ${rows.length}, inserted ${count}`);
  return count;
}
