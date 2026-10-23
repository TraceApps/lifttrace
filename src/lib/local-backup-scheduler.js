/**
 * local-backup-scheduler.js — fire scheduled local backups while
 * LiftTrace is open in local Android mode. TraceApps parity port from
 * NutriTrace / CookTrace.
 *
 * LT's local backup is a JSON dump (no images / no ZIP) so the saved
 * artifact is .json instead of .zip. Otherwise identical to NT + CT:
 * JS-side tick every 5 min + visibilitychange + 5s after mount, auto
 * prefix on filename, retention only touches files we wrote here.
 *
 * Settings: localBackupSchedule / Time / Retention / LastRun / LastError
 */
import { isNative, getNativeMode } from './platform.js';
import {
  localBackupSchedule, localBackupTime, localBackupRetention,
  localBackupLastRun, localBackupLastError, localBackupSetAt,
} from '../stores/settings.js';
import { isBackupDue, newestFirst } from '../../server/lib/backup-schedule.js';

const AUTO_PREFIX = 'lifttrace-backup-auto-';
const BACKUP_DIR  = 'lifttrace-backups';
const TICK_MS = 5 * 60 * 1000;

let _timer = null;
let _running = false;

function _isLocalMode() {
  return !!(isNative && getNativeMode() === 'local');
}

export function startLocalBackupScheduler() {
  if (_timer) return;
  if (!_isLocalMode()) return;
  setTimeout(_tick, 5_000);
  _timer = setInterval(_tick, TICK_MS);
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', _onVisibility);
  }
}

export function stopLocalBackupScheduler() {
  if (_timer) clearInterval(_timer);
  _timer = null;
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', _onVisibility);
  }
}

function _onVisibility() {
  if (document.visibilityState === 'visible') {
    setTimeout(_tick, 1_000);
  }
}

async function _tick() {
  if (_running) return;
  if (!_isLocalMode()) return;

  const schedule = localBackupSchedule.get();
  if (schedule === 'off') return;
  // The server's rule (TraceApps/notetrace#44), on this phone's own clock:
  // the time set, at least half an interval after the last run, so runs don't drift.
  const due = isBackupDue({
    schedule, time: localBackupTime.get() || '03:00', timeZone: null,
    lastAutoRun: localBackupLastRun.get() || null, setAt: localBackupSetAt.get() || null,
  });
  if (!due) return;

  await _runAutoBackup();
}

async function _runAutoBackup() {
  if (_running) return;
  _running = true;
  try {
    const { buildBackup } = await import('./local-backup.js');
    const data = await buildBackup();
    const json = JSON.stringify(data);
    const { localFileStamp } = await import('./file-stamp.js');
    const filename = `${AUTO_PREFIX}${localFileStamp()}.json`;
    await _writeBackupFile(filename, json);
    await _pruneAutoBackups(parseInt(localBackupRetention.get(), 10) || 7);
    localBackupLastRun.set(new Date().toISOString());
    localBackupLastError.set('');
    console.log(`[local-backup] auto-backup saved: ${filename}`);
  } catch (e) {
    const msg = e?.message || String(e);
    localBackupLastError.set(msg);
    console.warn(`[local-backup] auto-backup failed: ${msg}`);
  } finally {
    _running = false;
  }
}

async function _writeBackupFile(filename, json) {
  const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem');
  await Filesystem.mkdir({ path: BACKUP_DIR, directory: Directory.Documents, recursive: true }).catch(() => {});
  await Filesystem.writeFile({
    path: `${BACKUP_DIR}/${filename}`,
    data: json,
    directory: Directory.Documents,
    encoding: Encoding.UTF8,
  });
}

async function _pruneAutoBackups(retention) {
  const keep = Math.max(1, Math.min(99, parseInt(retention, 10) || 7));
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  try {
    const list = await Filesystem.readdir({ path: BACKUP_DIR, directory: Directory.Documents });
    // Newest first by the time in the name (local with its offset since
    // TraceApps/notetrace#44, UTC before), else the file's date.
    const autos = newestFirst((list.files || [])
      .filter(f => f.name && f.name.startsWith(AUTO_PREFIX) && f.name.endsWith('.json')));
    const toDelete = autos.slice(keep);
    for (const f of toDelete) {
      try {
        await Filesystem.deleteFile({ path: `${BACKUP_DIR}/${f.name}`, directory: Directory.Documents });
      } catch (e) {
        console.warn(`[local-backup] prune failed for ${f.name}: ${e.message}`);
      }
    }
  } catch (e) {
    console.warn(`[local-backup] prune list failed: ${e.message}`);
  }
}

export async function runLocalBackupNow() {
  if (!_isLocalMode()) throw new Error('Not in local mode');
  await _runAutoBackup();
}
