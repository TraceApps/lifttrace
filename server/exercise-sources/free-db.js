import db from '../db.js';
import { logger } from '../logger.js';
import { fetchFreeDbRows } from '../../src/lib/exercise-sources/free-db.js';

export async function seedFromFreeDb() {
  const rows = await fetchFreeDbRows();
  // Pre-check the natural key so a re-import reads as a no-op (matches
  // exercisedb-oss). INSERT OR IGNORE alone won't skip anything until
  // the partial UNIQUE(source, external_id) index is populated, and
  // even then SQLite treats NULL external_ids as distinct — legacy
  // rows from before the seeder started populating external_id fall
  // back to the (source, name) key.
  const existingExtIds = new Set(
    db.prepare(`SELECT external_id FROM exercises WHERE source = 'free-db' AND external_id IS NOT NULL`)
      .all()
      .map(r => String(r.external_id))
  );
  const existingNames = new Set(
    db.prepare(`SELECT name FROM exercises WHERE source = 'free-db' AND external_id IS NULL`)
      .all()
      .map(r => r.name)
  );
  const insert = db.prepare(
    `INSERT OR IGNORE INTO exercises
     (name, category, primary_muscles, secondary_muscles, equipment,
      instructions, img_url, gif_url, video_url, external_id, source, is_global)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'free-db', 1)`
  );
  let count = 0, skipped = 0;
  for (const r of rows) {
    if (r.external_id && existingExtIds.has(String(r.external_id))) { skipped++; continue; }
    if (!r.external_id && existingNames.has(r.name)) { skipped++; continue; }
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
  logger.info(`[free-db] processed ${rows.length}, inserted ${count}, skipped ${skipped} already-present`);
  return count;
}
