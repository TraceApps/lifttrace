/**
 * img-url-migration.js: pictures stored inline as data URLs become files, on
 * every startup.
 *
 * Before the sync push ran pictures through localizeDataUrl, a client of it
 * could leave an exercise picture or a progress photo in its row as a data
 * URL (so can a catalog import or a backup restore). Each startup converts
 * the ones still there, the way the REST routes would have. Only data URLs
 * the REST routes convert are touched: an upload path or an external URL is
 * never downloaded again, and a type they keep as it is (SVG, say) stays.
 * Deleted rows are skipped (nobody sees their picture, and converting it
 * would send them to every phone again for nothing). A row edited since the
 * scan keeps the edit. One that can't be converted is counted and logged,
 * and tried again next startup.
 *
 * field_times, the time each field was last edited, stays as it was: this is
 * not an edit, and the REST routes' newer-wins never reads updated_at.
 * updated_at moves (its trigger), which is how a pull finds the new path.
 * The old POST /api/sync/push does compare updated_at, so an edit to the row
 * made before the repair and pushed there after it loses; no LiftTrace app
 * has ever used that route. users has no pull cursor.
 *
 * set_media is not scanned: nothing writes a data URL there (the REST route
 * takes only an uploaded clip path, and the push never inserts or changes
 * one).
 *
 * The same shape as NutriTrace's server/lib/img-url-migration.js.
 */
import db from '../db.js';
import { logger } from '../logger.js';
import { localizeDataUrl } from './image-localizer.js';

const COLUMNS = [
  { table: 'exercises', column: 'img_url', live: 'deleted_at IS NULL' },
  { table: 'exercises', column: 'gif_url', live: 'deleted_at IS NULL' },
  { table: 'body_stat_media', column: 'url', live: 'deleted_at IS NULL', subdir: 'body-stats' },
  { table: 'users', column: 'avatar_url', live: '1' },
];

// What localizeDataUrl converts (image-localizer.js); any other data URL is
// kept as it is there too, so it is no failure to retry.
const CONVERTIBLE = /^data:image\/(jpeg|jpg|png|webp|gif|avif);base64,/i;

const nextTick = () => new Promise(r => setImmediate(r));

let pending;
export function migrateDataUrlImages() {
  if (!pending) pending = run().finally(() => { pending = null; });
  return pending;
}

async function run() {
  let migrated = 0, failed = 0;
  for (const { table, column, live, subdir } of COLUMNS) {
    // Ids first, each picture read only when its turn comes: a restored
    // backup full of them is never all in memory at once.
    const ids = db.prepare(`SELECT id FROM ${table} WHERE ${live} AND ${column} LIKE 'data:%'`).all().map(r => r.id);
    const current = db.prepare(`SELECT ${column} AS value FROM ${table} WHERE id = ? AND ${live}`);
    const update = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ? AND ${column} = ?`);
    for (const id of ids) {
      // One at a time, letting requests in between: startup isn't held up.
      await nextTick();
      // Read now, so a row edited or deleted since the scan is left alone.
      const value = current.get(id)?.value;
      if (typeof value !== 'string' || !CONVERTIBLE.test(value)) continue;
      try {
        const url = localizeDataUrl(value, subdir ? { subdir } : undefined);
        if (typeof url !== 'string' || /^data:/i.test(url)) throw new Error('not a supported image type');
        migrated += update.run(url, id, value).changes;
      } catch (e) {
        failed++;
        logger.warn(`[img-url-migration] ${table}.${column} id=${id}: could not store the image (${e.message}); will retry next startup`);
      }
    }
  }
  if (migrated || failed) logger.info(`[img-url-migration] stored ${migrated} inline image(s) as files, ${failed} failed`);
  return { migrated, failed };
}
