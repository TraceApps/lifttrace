/**
 * local-backup.js — JSON snapshot of the local SQLite database + local
 * uploaded media, produced entirely on-device.
 *
 * Used in Capacitor standalone mode where the server-driven full backup
 * (ZIP of server DB + uploads) isn't reachable. The user gets:
 *   - exportBackup() → write JSON file to device storage + Share sheet
 *   - importBackup(json) → restore from a previously-exported JSON
 *   - listLocalBackups() / deleteLocalBackup(name) for the Settings UI
 *
 * Format (schemaVersion 2, current):
 *   {
 *     version: 2,
 *     app: 'lifttrace',
 *     exportedAt: ISO timestamp,
 *     schemaVersion: 2,
 *     tables: { name: rows[] },
 *     uploads: { 'lifttrace-uploads/<file>': '<base64>' }
 *   }
 *
 * Format (schemaVersion 1, legacy): same shape without the `uploads`
 * field. `importBackup()` reads either — v1 restores DB tables only and
 * leaves the local uploads directory untouched, matching the app's
 * pre-rc.8 behaviour so backups taken on older builds still restore.
 */

import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { isNative } from './platform.js';
import { dbQuery, dbRun, getDb } from './db-native.js';

const BACKUP_DIR  = 'lifttrace-backups';
const UPLOADS_DIR = 'lifttrace-uploads';
const SCHEMA_VERSION = 2;

const TABLES = [
  'users',
  'user_settings',
  'app_config',
  'ai_chat_history',
  'exercises',
  'programs',
  'workout_templates',
  'program_assignments',
  'workout_log',
  'body_stats_log',
  'coach_prescriptions',
];

async function _ensureDir(path) {
  try { await Filesystem.mkdir({ path, directory: Directory.Data, recursive: true }); } catch {}
}

/** Read every file in Directory.Data/lifttrace-uploads and return them
 *  as a `{ 'lifttrace-uploads/<name>': '<base64>' }` map. Missing dir
 *  or unreadable files are silently skipped. */
async function _readUploads() {
  const uploads = {};
  let entries;
  try {
    const list = await Filesystem.readdir({ path: UPLOADS_DIR, directory: Directory.Data });
    entries = list?.files || [];
  } catch {
    return uploads;
  }
  for (const f of entries) {
    // Older Capacitor plugin versions return string names; newer ones
    // return { name, type, size, mtime } objects. Handle both.
    const name = typeof f === 'string' ? f : (f?.name || '');
    if (!name) continue;
    try {
      const data = await Filesystem.readFile({
        path: `${UPLOADS_DIR}/${name}`,
        directory: Directory.Data,
      });
      const b64 = typeof data?.data === 'string' ? data.data : '';
      if (b64) uploads[`${UPLOADS_DIR}/${name}`] = b64;
    } catch {}
  }
  return uploads;
}

/**
 * Dump every table + optionally every local upload to a single JSON
 * document.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.includeUploads=true] base64-inline every file
 *   in Directory.Data/lifttrace-uploads. Disable for a smaller,
 *   metadata-only dump (custom-exercise images will restore as broken
 *   references, matching the pre-rc.8 behaviour).
 */
export async function buildBackup(opts = {}) {
  const includeUploads = opts.includeUploads !== false;
  const out = {
    version: SCHEMA_VERSION,
    app: 'lifttrace',
    exportedAt: new Date().toISOString(),
    schemaVersion: SCHEMA_VERSION,
    tables: {},
  };
  for (const t of TABLES) {
    try { out.tables[t] = await dbQuery(`SELECT * FROM ${t}`, []); }
    catch { out.tables[t] = []; }
  }
  if (includeUploads) {
    out.uploads = await _readUploads();
  }
  return out;
}

/**
 * Write a backup to the device's data directory and (optionally) open
 * the system Share sheet so the user can save it elsewhere (Drive,
 * email, etc.). Set `opts.includeUploads = false` to produce a much
 * smaller metadata-only JSON.
 */
export async function exportBackup({ share = true, includeUploads = true } = {}) {
  if (!isNative) throw new Error('Local backup is Capacitor-only');
  await _ensureDir(BACKUP_DIR);
  const data = await buildBackup({ includeUploads });
  const json = JSON.stringify(data);
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = `${BACKUP_DIR}/lifttrace-${ts}.json`;
  const writeRes = await Filesystem.writeFile({
    path: name,
    data: json,
    directory: Directory.Data,
    encoding: Encoding.UTF8,
  });
  if (share) {
    try {
      await Share.share({
        title: 'LiftTrace backup',
        text: `Backup exported ${data.exportedAt}`,
        url: writeRes?.uri,
        dialogTitle: 'Save LiftTrace backup',
      });
    } catch {} // user cancelled — file is still written
  }
  return { name, path: writeRes?.uri, sizeBytes: json.length };
}

/**
 * Restore from a previously-exported JSON object. Replaces local data
 * entirely — destructive. Caller should confirm with the user first.
 *
 * v2 backups (rc.8+) restore both DB rows and the uploads/ directory.
 * v1 backups (rc.7 and earlier) restore DB rows only — the uploads
 * directory is left untouched so an in-place restore of an older
 * backup doesn't wipe media the user has kept intact.
 */
export async function importBackup(jsonOrText) {
  if (!isNative) throw new Error('Local backup is Capacitor-only');
  const data = typeof jsonOrText === 'string' ? JSON.parse(jsonOrText) : jsonOrText;
  if (!data || data.app !== 'lifttrace' || !data.tables) {
    throw new Error('Not a LiftTrace backup file');
  }
  // Wipe existing DB rows, then re-insert. Schema is preserved
  // (no DROP TABLE).
  for (const t of TABLES) {
    try { await dbRun(`DELETE FROM ${t}`, []); } catch {}
  }
  for (const t of TABLES) {
    const rows = data.tables[t] || [];
    for (const row of rows) {
      const cols = Object.keys(row);
      const placeholders = cols.map(() => '?').join(', ');
      const vals = cols.map(c => row[c] == null ? null : (typeof row[c] === 'object' ? JSON.stringify(row[c]) : row[c]));
      try {
        await dbRun(
          `INSERT OR REPLACE INTO ${t} (${cols.join(', ')}) VALUES (${placeholders})`,
          vals
        );
      } catch {}
    }
  }
  // v2+: write uploads back so custom-exercise / avatar images round-trip.
  let restoredUploads = 0;
  const uploads = data.uploads;
  if (uploads && typeof uploads === 'object') {
    await _ensureDir(UPLOADS_DIR);
    for (const [key, b64] of Object.entries(uploads)) {
      // Guard against tampered keys — accept only paths inside our
      // known uploads directory. Anything else is silently dropped so
      // a malicious backup can't scribble arbitrary files onto disk.
      if (!key.startsWith(`${UPLOADS_DIR}/`) || key.includes('..')) continue;
      if (typeof b64 !== 'string' || !b64) continue;
      try {
        await Filesystem.writeFile({
          path: key,
          data: b64,
          directory: Directory.Data,
        });
        restoredUploads++;
      } catch {}
    }
  }
  return { ok: true, tables: TABLES.length, uploads: restoredUploads };
}

export async function listLocalBackups() {
  if (!isNative) return [];
  await _ensureDir(BACKUP_DIR);
  try {
    const r = await Filesystem.readdir({ path: BACKUP_DIR, directory: Directory.Data });
    return (r?.files || [])
      .filter(f => (f.name || f).endsWith('.json'))
      .map(f => ({
        name: f.name || f,
        size: f.size || 0,
        ctime: f.ctime || null,
        mtime: f.mtime || null,
      }))
      .sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  } catch { return []; }
}

export async function readBackupFile(name) {
  const r = await Filesystem.readFile({
    path: `${BACKUP_DIR}/${name}`,
    directory: Directory.Data,
    encoding: Encoding.UTF8,
  });
  return typeof r.data === 'string' ? r.data : '';
}

export async function deleteLocalBackup(name) {
  try {
    await Filesystem.deleteFile({
      path: `${BACKUP_DIR}/${name}`,
      directory: Directory.Data,
    });
  } catch {}
}
