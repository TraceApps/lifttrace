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
  localBackupLastRun, localBackupLastError,
} from '../stores/settings.js';

const INTERVAL_MS = {
  daily:   22 * 60 * 60 * 1000,
  weekly:  6.5 * 24 * 60 * 60 * 1000,
  monthly: 28 * 24 * 60 * 60 * 1000,
};

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
  const intervalMs = INTERVAL_MS[schedule];
  if (!intervalMs) return;

  const timeStr = localBackupTime.get() || '03:00';
  const [hh, mm] = String(timeStr).split(':').map(n => parseInt(n, 10));
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return;

  const now = new Date();
  const scheduledMs = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0).getTime();
  if (now.getTime() < scheduledMs) return;

  const last = localBackupLastRun.get();
  if (last) {
    const lastMs = new Date(last).getTime();
    if (Number.isFinite(lastMs) && now.getTime() - lastMs < intervalMs) return;
  }

  await _runAutoBackup();
}

async function _runAutoBackup() {
  if (_running) return;
  _running = true;
  try {
    const { buildBackup } = await import('./local-backup.js');
    const data = await buildBackup();
    const json = JSON.stringify(data);
    const filename = `${AUTO_PREFIX}${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`;
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
    const autos = (list.files || [])
      .filter(f => f.name && f.name.startsWith(AUTO_PREFIX) && f.name.endsWith('.json'))
      .sort((a, b) => (b.name || '').localeCompare(a.name || ''));
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
