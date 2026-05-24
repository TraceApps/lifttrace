/**
 * local-backup.js — JSON snapshot of the local SQLite database.
 *
 * Used in Capacitor standalone mode where the server-driven full backup
 * (ZIP of server DB + uploads) isn't reachable. The user gets:
 *   - exportBackup() → write JSON file to device storage + Share sheet
 *   - importBackup(json) → restore from a previously-exported JSON
 *   - listLocalBackups() / deleteLocalBackup(name) for the Settings UI
 *
 * Format:
 *   { version: 1, app: 'lifttrace', exportedAt, schemaVersion, tables: { name: rows[] } }
 */

import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { isNative } from './platform.js';
import { dbQuery, dbRun, getDb } from './db-native.js';

const BACKUP_DIR = 'lifttrace-backups';
const SCHEMA_VERSION = 1;

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

async function _ensureDir() {
  try { await Filesystem.mkdir({ path: BACKUP_DIR, directory: Directory.Data, recursive: true }); } catch {}
}

/** Dump every table to a JSON document. */
export async function buildBackup() {
  const out = {
    version: 1,
    app: 'lifttrace',
    exportedAt: new Date().toISOString(),
    schemaVersion: SCHEMA_VERSION,
    tables: {},
  };
  for (const t of TABLES) {
    try { out.tables[t] = await dbQuery(`SELECT * FROM ${t}`, []); }
    catch { out.tables[t] = []; }
  }
  return out;
}

/**
 * Write a backup to the device's data directory and (optionally) open the
 * system Share sheet so the user can save it elsewhere (Drive, email, etc.).
 */
export async function exportBackup({ share = true } = {}) {
  if (!isNative) throw new Error('Local backup is Capacitor-only');
  await _ensureDir();
  const data = await buildBackup();
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
 */
export async function importBackup(jsonOrText) {
  if (!isNative) throw new Error('Local backup is Capacitor-only');
  const data = typeof jsonOrText === 'string' ? JSON.parse(jsonOrText) : jsonOrText;
  if (!data || data.app !== 'lifttrace' || !data.tables) {
    throw new Error('Not a LiftTrace backup file');
  }
  // Wipe existing data, then re-insert. Tables are dropped of their rows
  // but schema is preserved (no DROP TABLE).
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
  return { ok: true, tables: TABLES.length };
}

export async function listLocalBackups() {
  if (!isNative) return [];
  await _ensureDir();
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
