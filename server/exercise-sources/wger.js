import db from '../db.js';
import { logger } from '../logger.js';
import { fetchWgerRows } from '../../src/lib/exercise-sources/wger.js';

export async function seedFromWger() {
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
  let count = 0;
  for (const r of rows) {
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
  logger.info(`[wger] processed ${rows.length}, inserted ${count}`);
  return count;
}
