import db from '../db.js';
import { logger } from '../logger.js';
import { fetchWgerRows } from '../../src/lib/exercise-sources/wger.js';

export async function seedFromWger() {
  // Pre-check + resurrect: no-op for live rows, resurrect soft-deleted
  // rows in place to keep exercise_id references in workout_log JSON
  // blobs valid (#49).
  const liveExtIds = new Set(
    db.prepare(`SELECT external_id FROM exercises
                WHERE source = 'wger' AND external_id IS NOT NULL AND deleted_at IS NULL`)
      .all().map(r => String(r.external_id))
  );
  const resurrectByExtId = db.prepare(
    `UPDATE exercises
       SET deleted_at = NULL, updated_at = datetime('now')
     WHERE source = 'wger' AND external_id = ? AND deleted_at IS NOT NULL`
  );
  const insert = db.prepare(
    `INSERT OR IGNORE INTO exercises
      (name, category, primary_muscles, secondary_muscles, equipment,
       instructions, img_url, external_id, source, is_global)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'wger', 1)`
  );
  let rows;
  try {
    rows = await fetchWgerRows();
  } catch (e) {
    logger.error(`[wger] ${e.message}`);
    return 0;
  }
  let count = 0, skipped = 0, resurrected = 0;
  for (const r of rows) {
    if (r.external_id != null && liveExtIds.has(String(r.external_id))) { skipped++; continue; }
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
      r.img_url,
      r.external_id,
    );
    if (res.changes > 0) count++;
  }
  logger.info(`[wger] processed ${rows.length}, inserted ${count}, resurrected ${resurrected}, skipped ${skipped} already-present`);
  return count + resurrected;
}
