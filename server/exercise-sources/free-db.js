import db from '../db.js';
import { logger } from '../logger.js';
import { fetchFreeDbRows } from '../../src/lib/exercise-sources/free-db.js';

export async function seedFromFreeDb() {
  const rows = await fetchFreeDbRows();
  // Pre-check the natural key so a re-import reads as a no-op for
  // live rows and resurrects soft-deleted rows in place instead of
  // minting new ids that would orphan workout_log references (#49).
  // Reads elsewhere filter by `deleted_at IS NULL`, so the resurrected
  // row rejoins pickers + stats. Legacy free-db rows with NULL
  // external_id fall back to the (source, name) key.
  const liveExtIds = new Set(
    db.prepare(`SELECT external_id FROM exercises
                WHERE source = 'free-db' AND external_id IS NOT NULL AND deleted_at IS NULL`)
      .all().map(r => String(r.external_id))
  );
  const liveNames = new Set(
    db.prepare(`SELECT name FROM exercises
                WHERE source = 'free-db' AND external_id IS NULL AND deleted_at IS NULL`)
      .all().map(r => r.name)
  );
  const resurrectByExtId = db.prepare(
    `UPDATE exercises
       SET deleted_at = NULL, updated_at = datetime('now')
     WHERE source = 'free-db' AND external_id = ? AND deleted_at IS NOT NULL`
  );
  const resurrectByName = db.prepare(
    `UPDATE exercises
       SET deleted_at = NULL, updated_at = datetime('now')
     WHERE source = 'free-db' AND external_id IS NULL AND name = ? AND deleted_at IS NOT NULL`
  );
  const insert = db.prepare(
    `INSERT OR IGNORE INTO exercises
     (name, category, primary_muscles, secondary_muscles, equipment,
      instructions, img_url, gif_url, video_url, external_id, source, is_global)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'free-db', 1)`
  );
  let count = 0, skipped = 0, resurrected = 0;
  for (const r of rows) {
    if (r.external_id && liveExtIds.has(String(r.external_id))) { skipped++; continue; }
    if (!r.external_id && liveNames.has(r.name)) { skipped++; continue; }
    // Try to resurrect a soft-deleted row first (preserves the id,
    // which is what past workout_log JSON blobs point at).
    const resurrect = r.external_id
      ? resurrectByExtId.run(String(r.external_id))
      : resurrectByName.run(r.name);
    if (resurrect.changes > 0) { resurrected++; continue; }
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
  logger.info(`[free-db] processed ${rows.length}, inserted ${count}, resurrected ${resurrected}, skipped ${skipped} already-present`);
  return count + resurrected;
}
