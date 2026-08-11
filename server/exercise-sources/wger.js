import db from '../db.js';
import { logger } from '../logger.js';
import { fetchWgerRows } from '../../src/lib/exercise-sources/wger.js';

export async function seedFromWger() {
  // Pre-check so a re-import reads as a no-op (matches exercisedb-oss).
  const existingExtIds = new Set(
    db.prepare(`SELECT external_id FROM exercises WHERE source = 'wger' AND external_id IS NOT NULL`)
      .all()
      .map(r => String(r.external_id))
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
  let count = 0, skipped = 0;
  for (const r of rows) {
    if (r.external_id != null && existingExtIds.has(String(r.external_id))) { skipped++; continue; }
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
  logger.info(`[wger] processed ${rows.length}, inserted ${count}, skipped ${skipped} already-present`);
  return count;
}
