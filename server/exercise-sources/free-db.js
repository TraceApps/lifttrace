import db from '../db.js';
import { logger } from '../logger.js';
import { fetchFreeDbRows } from '../../src/lib/exercise-sources/free-db.js';

export async function seedFromFreeDb() {
  const rows = await fetchFreeDbRows();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO exercises
     (name, category, primary_muscles, secondary_muscles, equipment,
      instructions, img_url, gif_url, video_url, external_id, source, is_global)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'free-db', 1)`
  );
  let count = 0;
  for (const r of rows) {
    const res = insert.run(
      r.name, r.category,
      JSON.stringify(r.primary_muscles),
      JSON.stringify(r.secondary_muscles),
      JSON.stringify(r.equipment),
      r.instructions,
      r.img_url, r.gif_url, r.video_url,
      r.external_id,
    );
    if (res.changes > 0) count++;
  }
  logger.info(`[free-db] processed ${rows.length}, inserted ${count}`);
  return count;
}
