import express from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import AdmZip from 'adm-zip';
import multer from 'multer';
import db, { dedupeExercisesOnce } from '../db.js';
import { logger } from '../logger.js';
import { seedSmtpFromEnv } from '../email.js';
import { seedAiFromEnv } from '../ai.js';
import { adoptExistingPairings } from '../lib/coaching.js';
import { isValidTimeZone, processTimeZone } from '../lib/zoned-time.js';
import { effectiveTimeZone, nextBackupAt, backupFileStamp, newestFirst } from '../lib/backup-schedule.js';
// Makes the two-step sign-in tables a backup reads and restores (nutritrace#222).
import { logAfterRestore as logTwoStepAfterRestore } from '../lib/two-step.js';
import { keepSessionVersions } from '../lib/session-version.js';

const router = express.Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Multi-week progression columns (issue #13) were added after the first
// backup format. Older dumps predate them, so their rows lack the keys —
// and better-sqlite3 throws on a missing named parameter. Fill defaults so
// a legacy backup still restores, while a current backup round-trips the
// real values.
function _withField(row, key, fallback = null) {
  return key in row ? row : { ...row, [key]: fallback };
}
function _withProgramDefaults(p) {
  return {
    ...p,
    duration_weeks: p.duration_weeks ?? 1,
    advance_mode:   p.advance_mode   ?? 'sessions',
    on_complete:    p.on_complete    ?? 'hold',
  };
}
function _withAssignDefaults(a) {
  return {
    ...a,
    week_cursor:              a.week_cursor              ?? null,
    week_cursor_session_base: a.week_cursor_session_base ?? null,
    week_cursor_pinned_at:    a.week_cursor_pinned_at    ?? null,
  };
}

const UPLOADS_DIR = process.env.UPLOADS_PATH || path.resolve(__dirname, '..', 'uploads');
const BACKUPS_DIR = process.env.BACKUPS_PATH || path.join(UPLOADS_DIR, 'backups');
fs.mkdirSync(BACKUPS_DIR, { recursive: true });

// ── Schedule config — TraceApps parity with NT + CT ──────────────────
// See NT's server/routes/full-backup.js for the canonical design.
// Env-lock: BACKUP_SCHEDULE / BACKUP_TIME / BACKUP_RETENTION.
const SCHEDULES = new Set(['off', 'daily', 'weekly', 'monthly']);
const DEFAULT_SCHEDULE = 'off';
const DEFAULT_TIME = '03:00';
const DEFAULT_RETENTION = 7;

export function isBackupEnvLocked() {
  return !!(process.env.BACKUP_SCHEDULE
         || process.env.BACKUP_TIME
         || process.env.BACKUP_RETENTION);
}

function _cfg(key) {
  return db.prepare('SELECT value FROM app_config WHERE key = ?').get(key)?.value;
}
function _setCfg(key, value) {
  db.prepare('INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value == null ? '' : String(value));
}

export function getScheduleConfig() {
  const envSchedule  = process.env.BACKUP_SCHEDULE;
  const envTime      = process.env.BACKUP_TIME;
  const envRetention = process.env.BACKUP_RETENTION;
  const schedule = SCHEDULES.has(envSchedule) ? envSchedule
                 : SCHEDULES.has(_cfg('backup_schedule')) ? _cfg('backup_schedule')
                 : DEFAULT_SCHEDULE;
  const time     = (envTime && /^\d{1,2}:\d{2}$/.test(envTime)) ? envTime
                 : (_cfg('backup_time') && /^\d{1,2}:\d{2}$/.test(_cfg('backup_time'))) ? _cfg('backup_time')
                 : DEFAULT_TIME;
  const retention = Math.max(1, Math.min(99, parseInt(envRetention || _cfg('backup_retention') || DEFAULT_RETENTION, 10) || DEFAULT_RETENTION));
  // The zone the time is in: saved with it from the browser that set it
  // (TraceApps/notetrace#44); none (older installs, a schedule set by
  // environment) runs in the server's own zone, TZ or UTC.
  const saved = isBackupEnvLocked() ? null : (_cfg('backup_time_zone') || null);
  const timeZone = isValidTimeZone(saved) ? saved : null;
  const lastAutoRun = _cfg('backup_last_auto_run') || null;
  const setAt = _cfg('backup_schedule_set_at') || null;
  return {
    schedule, time, retention,
    timeZone,
    runsIn:        effectiveTimeZone(timeZone),
    serverTimeZone: processTimeZone(),
    setAt,
    nextRunAt:     nextBackupAt({ schedule, time, timeZone, lastAutoRun, setAt }),
    lastAutoRun,
    lastAutoError: _cfg('backup_last_auto_error') || null,
    envLocked:     isBackupEnvLocked(),
  };
}

export function setScheduleConfig({ schedule, time, retention, timeZone }) {
  if (isBackupEnvLocked()) {
    const err = new Error('Backup schedule is locked by environment variable');
    err.code = 'ENV_LOCKED';
    throw err;
  }
  // Every field checked before any is saved: a bad one changes nothing.
  const writes = [];
  if (schedule != null) {
    if (!SCHEDULES.has(schedule)) throw new Error('schedule must be one of: off, daily, weekly, monthly');
    writes.push(['backup_schedule', schedule]);
  }
  if (time != null) {
    if (!/^\d{1,2}:\d{2}$/.test(time)) throw new Error('time must be HH:MM');
    const [h, m] = time.split(':').map(n => parseInt(n, 10));
    if (h < 0 || h > 23 || m < 0 || m > 59) throw new Error('time out of range');
    writes.push(['backup_time', `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`]);
  }
  if (retention != null) {
    const r = parseInt(retention, 10);
    if (!Number.isFinite(r) || r < 1 || r > 99) throw new Error('retention must be 1-99');
    writes.push(['backup_retention', String(r)]);
  }
  // An IANA zone such as "America/New_York"; '' goes back to the server's zone.
  if (timeZone !== undefined) {
    if (timeZone === null || timeZone === '') writes.push(['backup_time_zone', '']);
    else if (!isValidTimeZone(timeZone)) throw new Error('timeZone must be an IANA time zone, such as America/New_York');
    else writes.push(['backup_time_zone', timeZone]);
  }
  // When it was set, for a first run that comes at its time (backup-schedule.js).
  if (schedule != null || time != null || timeZone !== undefined) writes.push(['backup_schedule_set_at', new Date().toISOString()]);
  db.transaction(() => { for (const [k, v] of writes) _setCfg(k, v); })();
  return getScheduleConfig();
}

export function createBackup({ now = Date.now() } = {}) {
  // Named in the schedule's zone with its offset (TraceApps/notetrace#44).
  // Never overwrite: two backups in the same second get a number.
  const timestamp = backupFileStamp(getScheduleConfig().timeZone, now);
  let filename = `lifttrace-backup-${timestamp}.zip`;
  for (let n = 2; fs.existsSync(path.join(BACKUPS_DIR, filename)); n++) filename = `lifttrace-backup-${timestamp}-${n}.zip`;
  const destPath  = path.join(BACKUPS_DIR, filename);
  const zip = new AdmZip();
  zip.addFile('database.json', Buffer.from(JSON.stringify(dumpDatabase(), null, 2), 'utf8'));
  if (fs.existsSync(UPLOADS_DIR)) {
    const addDir = (dir, zipPath) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        const zp = zipPath ? `${zipPath}/${entry.name}` : entry.name;
        if (entry.isDirectory()) { if (full === BACKUPS_DIR) continue; addDir(full, zp); }
        else { zip.addFile(`images/${zp}`, fs.readFileSync(full)); }
      }
    };
    addDir(UPLOADS_DIR, '');
  }
  zip.writeZip(destPath);
  const stat = fs.statSync(destPath);
  return { filename, size: stat.size, createdAt: new Date(now).toISOString() };
}

export function pruneOldBackups(retention) {
  const keep = Math.max(1, Math.min(99, parseInt(retention, 10) || DEFAULT_RETENTION));
  // Newest first by when each was made, read from the name (local time with
  // its offset since TraceApps/notetrace#44, UTC before), so a copied folder
  // that lost its file dates still keeps the right ones; the file's date only
  // for other names.
  const all = newestFirst(fs.readdirSync(BACKUPS_DIR)
    .filter(f => f.startsWith('lifttrace-backup-') && f.endsWith('.zip'))
    .map(name => ({ name, mtime: (() => { try { return fs.statSync(path.join(BACKUPS_DIR, name)).mtimeMs; } catch { return 0; } })() })))
    .map(x => x.name);
  const toDelete = all.slice(keep);
  for (const f of toDelete) {
    try { fs.unlinkSync(path.join(BACKUPS_DIR, f)); }
    catch (e) { logger.warn?.(`[backup] prune failed for ${f}: ${e.message}`); }
  }
  return toDelete;
}

export async function runScheduledBackup() {
  const cfg = getScheduleConfig();
  try {
    const result = createBackup();
    pruneOldBackups(cfg.retention);
    _setCfg('backup_last_auto_run', new Date().toISOString());
    _setCfg('backup_last_auto_error', '');
    logger.info?.(`[backup] scheduled backup ok: ${result.filename} (${(result.size / 1024 / 1024).toFixed(1)} MB), pruned to ${cfg.retention}`);
    return result;
  } catch (e) {
    _setCfg('backup_last_auto_error', e.message || String(e));
    logger.warn?.(`[backup] scheduled backup failed: ${e.message}`);
    try {
      const adminRow = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
      if (adminRow) {
        const { pushNotify } = await import('../lib/push-notify.js');
        await pushNotify(adminRow.id, 'notifBackupFailed',
          '🛟 LiftTrace backup failed',
          `Scheduled backup error: ${e.message || 'unknown'}`,
          7);
      }
    } catch {}
    throw e;
  }
}

// Backup upload size cap: 512 MB by default. Override via env if you have
// a genuinely huge backup (massive uploads/ folder). Was 2 GB.
const _backupMaxMB = parseInt(process.env.BACKUP_UPLOAD_MAX_MB || '512', 10);
const upload = multer({
  storage: multer.diskStorage({ destination: (req, file, cb) => cb(null, os.tmpdir()) }),
  limits: { fileSize: _backupMaxMB * 1024 * 1024 },
});

// Zip-slip + zip-bomb defense.
//   * Path normalization rejects any entry that resolves outside UPLOADS_DIR.
//   * Hard caps on entry count + total uncompressed size prevent a tiny
//     malicious ZIP from filling the disk on restore.
const ZIP_MAX_ENTRIES = 50_000;
const ZIP_MAX_UNCOMPRESSED_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB
function _safeZipExtractPath(rel, baseDir) {
  // Strip any drive letter / leading slashes / backslashes / "../" segments.
  const cleaned = String(rel || '')
    .replace(/^[a-zA-Z]:/, '')
    .replace(/[\\]/g, '/')
    .split('/')
    .filter(part => part && part !== '.' && part !== '..')
    .join('/');
  if (!cleaned) return null;
  const resolved = path.resolve(baseDir, cleaned);
  // Must remain under baseDir
  const baseResolved = path.resolve(baseDir);
  if (resolved !== baseResolved && !resolved.startsWith(baseResolved + path.sep)) return null;
  return resolved;
}

function requireAdmin(req, res, next) {
  // In single-user mode (no users registered), allow all backup operations
  const hasUsers = db.prepare('SELECT 1 FROM users LIMIT 1').get();
  if (!hasUsers) return next();
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

function restoreFromZip(zip) {
  const data = JSON.parse(zip.readAsText('database.json'));
  // Signed-out sessions stay signed out (lib/session-version.js).
  keepSessionVersions(() => db.transaction(() => {
    // What devices may hold of the tables that say a row is gone only with
    // its deleted_at, read before the wipe (keepGone, below).
    const before = rowsBefore();
    db.prepare('DELETE FROM password_reset_tokens').run();
    db.prepare('DELETE FROM invite_tokens').run();
    db.prepare('DELETE FROM user_settings').run();
    db.prepare('DELETE FROM app_config').run();
    db.prepare('DELETE FROM workout_log').run();
    db.prepare('DELETE FROM body_stats_log').run();
    db.prepare('DELETE FROM body_stat_media').run();
    db.prepare('DELETE FROM set_media').run();
    db.prepare('DELETE FROM coach_prescriptions').run();
    db.prepare('DELETE FROM workout_templates').run();
    db.prepare('DELETE FROM program_assignments').run();
    db.prepare('DELETE FROM programs').run();
    db.prepare('DELETE FROM exercises WHERE is_global = 0').run(); // keep global seeds, restore custom
    // OIDC: clear in dependency order — links FK to providers, both FK to users.
    try { db.prepare('DELETE FROM user_oidc_links').run(); } catch {}
    try { db.prepare('DELETE FROM oidc_providers').run(); } catch {}
    db.prepare('DELETE FROM users').run();

    // Two-pass user restore: insert with trainer_id NULL (avoids FK ordering), then fix up
    const insUser = db.prepare(`INSERT OR IGNORE INTO users (id,username,password_hash,full_name,nickname,email,birthday,gender,avatar_url,role,created_at) VALUES (@id,@username,@password_hash,@full_name,@nickname,@email,@birthday,@gender,@avatar_url,@role,@created_at)`);
    const linkTrainer = db.prepare('UPDATE users SET trainer_id = ? WHERE id = ?');
    for (const u of data.users || []) insUser.run(u);
    for (const u of data.users || []) if (u.trainer_id) linkTrainer.run(u.trainer_id, u.id);

    // Coaching pairings (requests, answers, endings). Emptied with the users
    // above (they cascade). A backup from before they existed has none: its
    // trainers are kept as accepted pairings after the restore
    // (adoptExistingPairings, below).
    db.prepare('DELETE FROM coach_clients').run();
    const insPairing = db.prepare(`INSERT OR IGNORE INTO coach_clients (id,coach_id,client_id,status,note,requested_at,responded_at,ended_at,ended_by,updated_at) VALUES (@id,@coach_id,@client_id,@status,@note,@requested_at,@responded_at,@ended_at,@ended_by,@updated_at)`);
    for (const c of data.coach_clients || []) {
      insPairing.run({ note: null, responded_at: null, ended_at: null, ended_by: null, ...c,
        requested_at: c.requested_at || c.updated_at || new Date().toISOString().replace('T', ' ').slice(0, 19),
        updated_at: c.updated_at || c.requested_at || new Date().toISOString().replace('T', ' ').slice(0, 19) });
    }
    // Their conversations (the photos come back with the uploads folder).
    // updated_at is now, so every phone and browser gets the conversation
    // again as restored (a message deleted since the backup comes back).
    db.prepare('DELETE FROM coach_messages').run();
    const insMessage = db.prepare(`INSERT OR IGNORE INTO coach_messages (id,uuid,pairing_id,sender_id,body,image_url,recommendation_id,read_at,created_at,updated_at,deleted_at) VALUES (@id,@uuid,@pairing_id,@sender_id,@body,@image_url,@recommendation_id,@read_at,COALESCE(@created_at, datetime('now')),datetime('now'),@deleted_at)`);
    for (const m of data.coach_messages || []) {
      insMessage.run({ body: null, image_url: null, recommendation_id: null, read_at: null, created_at: null, deleted_at: null, ...m });
    }

    // Rows deleted softly come back deleted (deleted_at), here and in every
    // table below that keeps one, so a restore never brings back what was
    // deleted before the backup. updated_at is left to the trigger (now):
    // every phone pulls the restored rows, the deleted ones as deleted, and
    // drops them. A backup from before deleted_at has none: all alive.

    // Restore custom exercises (user-created, not global seeds)
    const insExercise = db.prepare(`INSERT OR IGNORE INTO exercises (id,name,category,primary_muscles,secondary_muscles,equipment,instructions,tips,img_url,gif_url,video_url,external_id,source,is_global,created_by,created_at,load_type,set_type,field_times,deleted_at) VALUES (@id,@name,@category,@primary_muscles,@secondary_muscles,@equipment,@instructions,@tips,@img_url,@gif_url,@video_url,@external_id,@source,@is_global,@created_by,@created_at,@load_type,@set_type,@field_times,@deleted_at)`);
    for (const e of data.exercises || []) insExercise.run({ load_type: null, set_type: null, field_times: null, deleted_at: null, ...e });

    const insProgram = db.prepare(`INSERT OR IGNORE INTO programs (id,name,description,goal,created_by,visibility,created_at,duration_weeks,advance_mode,on_complete,field_times,deleted_at) VALUES (@id,@name,@description,@goal,@created_by,@visibility,@created_at,@duration_weeks,@advance_mode,@on_complete,@field_times,@deleted_at)`);
    for (const p of data.programs || []) insProgram.run({ field_times: null, deleted_at: null, ..._withProgramDefaults(p) });

    const insTemplate = db.prepare(`INSERT OR IGNORE INTO workout_templates (id,program_id,name,day_label,order_index,exercises,created_at,field_times,deleted_at) VALUES (@id,@program_id,@name,@day_label,@order_index,@exercises,@created_at,@field_times,@deleted_at)`);
    for (const t of data.workout_templates || []) insTemplate.run({ field_times: null, deleted_at: null, ...t });

    const insAssign = db.prepare(`INSERT OR IGNORE INTO program_assignments (id,program_id,assigned_to,assigned_by,start_date,active,assigned_at,week_cursor,week_cursor_session_base,week_cursor_pinned_at,deleted_at) VALUES (@id,@program_id,@assigned_to,@assigned_by,@start_date,@active,@assigned_at,@week_cursor,@week_cursor_session_base,@week_cursor_pinned_at,@deleted_at)`);
    for (const a of data.program_assignments || []) insAssign.run(_withField(_withAssignDefaults(a), 'deleted_at'));

    // A backup from before the Accept step has no status: accepted, as at upgrade.
    const insPrescription = db.prepare(`INSERT OR IGNORE INTO coach_prescriptions (id,trainer_id,member_id,date,template_id,name,exercises,notes,created_at,status,responded_at) VALUES (@id,@trainer_id,@member_id,@date,@template_id,@name,@exercises,@notes,@created_at,@status,@responded_at)`);
    for (const cp of data.coach_prescriptions || []) insPrescription.run({ responded_at: null, ...cp, status: cp.status || 'accepted' });

    // session_seq: the order of a day's workouts (issue #76); 0, as at
    // upgrade, in a backup from before it.
    const insWorkout = db.prepare(`INSERT OR IGNORE INTO workout_log (id,user_id,date,template_id,program_id,name,exercises,notes,duration_min,completed,created_at,program_week,field_times,deleted_at,session_seq) VALUES (@id,@user_id,@date,@template_id,@program_id,@name,@exercises,@notes,@duration_min,@completed,@created_at,@program_week,@field_times,@deleted_at,@session_seq)`);
    for (const w of data.workout_log || []) insWorkout.run({ ..._withField(_withField(_withField(w, 'program_week'), 'field_times'), 'deleted_at'), session_seq: w.session_seq ?? 0 });

    // Exercises and sets deleted inside a workout or workout day
    // (workout_tombstones): what keeps a device that still holds one from
    // putting it back. Those of the backup come back; ones made since stay,
    // unless the restore brought back what they deleted: then they'd take it
    // away again on the next save, so they go (restoreTombstones).
    restoreTombstones(data.workout_tombstones);

    // Coach feedback: trainer notes on member workouts, plus the member's
    // read-receipt (seen_by_member_at) and single reply (member_reply /
    // member_replied_at). Round-trip everything so the feedback loop
    // survives restore. Must run AFTER workout_log insert because
    // coach_feedback.workout_id references workout_log(id). Legacy backups
    // predate these columns, so default them to NULL via _withField.
    // The earlier DELETE FROM users cascades and already emptied this table;
    // the DELETE here is defensive in case that cascade path ever changes.
    // A note on a set video keeps the video (media_id), the moment in it
    // (media_time_sec) and the exercise it is on (exercise_uuid, issue #57).
    db.prepare('DELETE FROM coach_feedback').run();
    const insFeedback = db.prepare(`INSERT OR IGNORE INTO coach_feedback (id,trainer_id,member_id,workout_id,exercise_idx,note,created_at,updated_at,seen_by_member_at,member_reply,member_replied_at,media_id,media_time_sec,exercise_uuid) VALUES (@id,@trainer_id,@member_id,@workout_id,@exercise_idx,@note,@created_at,@updated_at,@seen_by_member_at,@member_reply,@member_replied_at,@media_id,@media_time_sec,@exercise_uuid)`);
    for (const f of data.coach_feedback || []) {
      const row = { media_id: null, media_time_sec: null, exercise_uuid: null, ..._withField(_withField(_withField(_withField(_withField(f,
        'updated_at'), 'seen_by_member_at'), 'member_reply'), 'member_replied_at'), 'exercise_idx') };
      insFeedback.run(row);
    }

    // Coach activity feed: the trainer's inbox of member events
    // (prescription completed / missed, feedback replies) with per-event
    // seen_at state. Preserving occurred_at + seen_at keeps unread counts
    // accurate across a restore. Must run AFTER coach_prescriptions,
    // workout_log, and coach_feedback because the FK columns
    // (prescription_id, workout_id, feedback_id) reference them. The
    // feedback_id column is a later addition; legacy backups without it
    // default to NULL.
    db.prepare('DELETE FROM coach_activity').run();
    const insActivity = db.prepare(`INSERT OR IGNORE INTO coach_activity (id,trainer_id,member_id,kind,prescription_id,workout_id,occurred_at,seen_at,feedback_id) VALUES (@id,@trainer_id,@member_id,@kind,@prescription_id,@workout_id,@occurred_at,@seen_at,@feedback_id)`);
    for (const a of data.coach_activity || []) {
      insActivity.run(_withField(a, 'feedback_id'));
    }

    const insBody = db.prepare(`INSERT OR IGNORE INTO body_stats_log (id,user_id,date,stats,field_times,deleted_at) VALUES (@id,@user_id,@date,@stats,@field_times,@deleted_at)`);
    for (const b of data.body_stats_log || []) insBody.run(_withField(_withField(b, 'field_times'), 'deleted_at'));

    // Progress photos. The image files themselves already ride along in
    // the zip (createBackup walks all of uploads/ recursively), so only
    // the rows pointing at them need restoring, without these the files
    // would land on disk with nothing referencing them. Every column is
    // carried through but updated_at, so a soft-deleted photo stays deleted
    // after a restore, and every device pulls them again (the trigger: now).
    const insPhoto = db.prepare(`INSERT OR IGNORE INTO body_stat_media (id,user_id,date,kind,url,created_at,deleted_at) VALUES (@id,@user_id,@date,@kind,@url,@created_at,@deleted_at)`);
    for (const p of data.body_stat_media || []) {
      insPhoto.run({ kind: 'photo', created_at: null, deleted_at: null, ...p });
    }

    // Set videos (issue #57), same shape of restore: the files themselves
    // ride along in the archive because it zips all of UPLOADS_DIR, so only
    // the rows need writing back. Without this a restore would leave the
    // clips on disk with nothing pointing at them.
    const insClip = db.prepare(`INSERT OR IGNORE INTO set_media (id,user_id,workout_id,date,exercise_uuid,set_uuid,url,mime,duration_sec,size_bytes,created_at,deleted_at) VALUES (@id,@user_id,@workout_id,@date,@exercise_uuid,@set_uuid,@url,@mime,@duration_sec,@size_bytes,@created_at,@deleted_at)`);
    for (const m of data.set_media || []) {
      insClip.run({
        workout_id: null, exercise_uuid: null, set_uuid: null, mime: null,
        duration_sec: null, size_bytes: null, created_at: null, deleted_at: null, ...m,
      });
    }

    // Cardio sessions. Legacy backups (pre-v1.1.0) have no cardio_log key
    // so `data.cardio_log || []` handles the gap silently. Wipe first so
    // restore is authoritative rather than merge-append.
    db.prepare('DELETE FROM cardio_log').run();
    const insCardio = db.prepare(`INSERT OR IGNORE INTO cardio_log (id,user_id,date,activity,duration_min,distance,distance_unit,avg_hr,notes,is_template,external_id,created_at,updated_at) VALUES (@id,@user_id,@date,@activity,@duration_min,@distance,@distance_unit,@avg_hr,@notes,@is_template,@external_id,@created_at,@updated_at)`);
    // external_id (#134) comes back with its session, so a script that logs
    // through the API still finds what it sent before the restore; a backup
    // from before it has none.
    for (const c of data.cardio_log || []) insCardio.run({ is_template: 0, external_id: null, ...c });

    // Excused days (issue #121). A backup from before them has none: the
    // restore is the backup's data, so none stay. Removed ones keep their
    // deleted_at, so a phone still showing one drops it. updated_at is left
    // to the trigger (now), so every phone pulls what was restored.
    db.prepare('DELETE FROM excused_days').run();
    const insExcused = db.prepare(`INSERT OR IGNORE INTO excused_days (id,user_id,date,reason,note,created_at,deleted_at,field_times) VALUES (@id,@user_id,@date,@reason,@note,@created_at,@deleted_at,@field_times)`);
    for (const e of data.excused_days || []) {
      insExcused.run({ note: null, created_at: null, deleted_at: null, field_times: null, ...e });
    }

    const insSettings = db.prepare(`INSERT OR IGNORE INTO user_settings (user_id,key,value,field_times) VALUES (@user_id,@key,@value,@field_times)`);
    for (const s of data.user_settings || []) insSettings.run(_withField(s, 'field_times'));

    const insConfig = db.prepare(`INSERT OR REPLACE INTO app_config (key,value) VALUES (@key,@value)`);
    for (const c of data.app_config || []) insConfig.run(c);

    db.prepare('DELETE FROM ai_chat_history').run();
    const insChat = db.prepare(`INSERT OR IGNORE INTO ai_chat_history (id,user_id,role,content,created_at,deleted_at) VALUES (@id,@user_id,@role,@content,@created_at,@deleted_at)`);
    for (const m of data.ai_chat_history || []) insChat.run(_withField(m, 'deleted_at'));

    // Two-step sign-in (nutritrace#222): secrets as stored (locked with this
    // server's two-step key, so on another server they can't be opened and
    // the person signs in with a recovery code or has it reset) and the
    // hashes of recovery codes. A backup from before it has none: two-step
    // sign-in is off for everyone after restoring it. The users above
    // cascaded the old rows away; rows for an account the archive lacks are
    // skipped.
    db.prepare('DELETE FROM user_two_step').run();
    db.prepare('DELETE FROM user_two_step_recovery').run();
    const restoredUsers = new Set(db.prepare('SELECT id FROM users').all().map(r => r.id));
    const insTwoStep = db.prepare(`
      INSERT OR IGNORE INTO user_two_step (user_id, secret_enc, enabled, last_step, created_at, enabled_at)
      VALUES (@user_id, @secret_enc, @enabled, @last_step, COALESCE(@created_at, datetime('now')), @enabled_at)
    `);
    for (const t of (data.user_two_step || []).filter(x => restoredUsers.has(x.user_id))) insTwoStep.run({
      enabled: 0, last_step: 0, created_at: null, enabled_at: null, ...t,
    });
    const insRecovery = db.prepare(`
      INSERT OR IGNORE INTO user_two_step_recovery (id, user_id, code_hash, used_at, created_at)
      VALUES (@id, @user_id, @code_hash, @used_at, COALESCE(@created_at, datetime('now')))
    `);
    for (const r of (data.user_two_step_recovery || []).filter(x => restoredUsers.has(x.user_id))) insRecovery.run({
      id: null, used_at: null, created_at: null, ...r,
    });

    // What other apps and scripts use to reach this server, set up by hand:
    // API tokens (hashed) and webhooks (the secret locked with this server's
    // key, so on another server a delivery fails until the webhook is made
    // again, and Settings says so), and invites not yet used. The users
    // above cascaded the old ones away; a backup from before they were kept
    // has none.
    const insToken = db.prepare(`INSERT OR IGNORE INTO api_tokens (id,user_id,name,token_hash,scopes,expires_at,last_used_at,created_at) VALUES (@id,@user_id,@name,@token_hash,@scopes,@expires_at,@last_used_at,COALESCE(@created_at, datetime('now')))`);
    for (const t of (data.api_tokens || []).filter(x => restoredUsers.has(x.user_id))) insToken.run({
      expires_at: null, last_used_at: null, created_at: null, ...t,
    });
    const insHook = db.prepare(`INSERT OR IGNORE INTO webhooks (id,user_id,url,secret_encrypted,events,enabled,last_delivery_at,last_delivery_status,last_delivery_error,created_at) VALUES (@id,@user_id,@url,@secret_encrypted,@events,@enabled,@last_delivery_at,@last_delivery_status,@last_delivery_error,COALESCE(@created_at, datetime('now')))`);
    for (const w of (data.webhooks || []).filter(x => restoredUsers.has(x.user_id))) insHook.run({
      enabled: 1, last_delivery_at: null, last_delivery_status: null, last_delivery_error: null, created_at: null, ...w,
    });
    const insInvite = db.prepare(`INSERT OR IGNORE INTO invite_tokens (token,email,role,created_by,expires_at,used,coach_id) VALUES (@token,@email,@role,@created_by,@expires_at,@used,@coach_id)`);
    const userOrNull = id => (id != null && restoredUsers.has(id) ? id : null);
    for (const i of (data.invite_tokens || []).filter(x => x?.token && x.expires_at)) insInvite.run({
      email: null, role: 'member', used: 0, ...i, created_by: userOrNull(i.created_by), coach_id: userOrNull(i.coach_id),
    });

    // Coach messages, progress photos and set videos a device may hold
    // that the backup doesn't: kept as deleted, so devices drop them.
    keepGone(before);

    // OIDC providers: client_secret stays encrypted in the dump and is
    // round-tripped as-is. Restoring on a host with a different JWT_SECRET
    // (and no TOKEN_ENC_KEY override) will fail to decrypt — admin will
    // need to re-enter the secret in Settings → OIDC.
    try {
      const insProvider = db.prepare(`INSERT OR IGNORE INTO oidc_providers
        (id,issuer_url,client_id,client_secret,redirect_uris,scope,token_endpoint_auth_method,response_types,
         id_token_signed_response_alg,userinfo_signed_response_alg,request_timeout_ms,
         auto_register,auto_link_verified_email,auto_register_new_users,
         admin_group_claim,admin_group_value,display_name,logo_url,is_active,created_at,updated_at)
        VALUES (@id,@issuer_url,@client_id,@client_secret,@redirect_uris,@scope,@token_endpoint_auth_method,@response_types,
                @id_token_signed_response_alg,@userinfo_signed_response_alg,@request_timeout_ms,
                @auto_register,@auto_link_verified_email,@auto_register_new_users,
                @admin_group_claim,@admin_group_value,@display_name,@logo_url,@is_active,@created_at,@updated_at)`);
      for (const p of data.oidc_providers || []) insProvider.run(p);
      const insLink = db.prepare(`INSERT OR IGNORE INTO user_oidc_links
        (id,user_id,oidc_provider_id,oidc_sub,email_verified,last_login_at,created_at)
        VALUES (@id,@user_id,@oidc_provider_id,@oidc_sub,@email_verified,@last_login_at,@created_at)`);
      for (const l of data.user_oidc_links || []) insLink.run(l);
    } catch (e) {
      // OIDC tables may not exist on a backup taken from a pre-OIDC build —
      // skip silently rather than abort the whole restore.
    }

    // Backups taken during the pre-#34 window can carry duplicate global
    // exercises (INSERT OR IGNORE was a no-op without a UNIQUE constraint).
    // Force-run the dedupe pass unconditionally so the restore lands on
    // the same clean shape a fresh boot does — merges non-null user edits,
    // rewrites exercise_id refs in the JSON blobs we just inserted,
    // deletes the duplicate rows.
    try { dedupeExercisesOnce({ force: true }); }
    catch (e) { logger.warn?.(`[restore] exercise dedupe skipped: ${e?.message || e}`); }
  })(), data.users);

  // Restore images — guarded against zip-slip + zip-bomb
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  const allEntries = zip.getEntries();
  if (allEntries.length > ZIP_MAX_ENTRIES) {
    throw new Error(`Backup rejected: too many entries (${allEntries.length} > ${ZIP_MAX_ENTRIES}).`);
  }
  let totalBytes = 0;
  for (const entry of allEntries) {
    if (!entry.entryName.startsWith('images/') || entry.isDirectory) continue;
    const rel = entry.entryName.slice('images/'.length);
    const dest = _safeZipExtractPath(rel, UPLOADS_DIR);
    if (!dest) continue;                    // path-traversal attempt — silently skip
    const data = entry.getData();
    totalBytes += data.length;
    if (totalBytes > ZIP_MAX_UNCOMPRESSED_BYTES) {
      throw new Error(`Backup rejected: uncompressed size exceeds ${Math.floor(ZIP_MAX_UNCOMPRESSED_BYTES / 1024 / 1024 / 1024)} GB.`);
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
  }
  seedSmtpFromEnv();
  seedAiFromEnv();
  // A backup from before coaching asked for consent: its trainers stay, as
  // accepted pairings with nothing to answer.
  try { adoptExistingPairings(); } catch { /* the next start-up does it */ }
  logTwoStepAfterRestore();
}

// Tables whose rows a device pulls whole and that say a row is gone only by
// its deleted_at (no sync_deletions record), with who has to be the same
// before and after the restore for a row to be theirs (an account: its id,
// username and when it was made).
function rowsBefore() {
  const all = (sql) => { try { return db.prepare(sql).all(); } catch { return []; } };
  return {
    users: new Map(all('SELECT id, username, created_at FROM users').map(u => [u.id, `${u.username}\n${u.created_at}`])),
    pairings: new Map(all('SELECT id, coach_id, client_id FROM coach_clients').map(p => [p.id, p])),
    coach_messages: all('SELECT * FROM coach_messages'),
    body_stat_media: all('SELECT * FROM body_stat_media'),
    set_media: all('SELECT * FROM set_media'),
  };
}

/**
 * A row a device may hold that the restore took away is put back deleted,
 * the way these tables say a row is gone, so every device that pulls it
 * drops its copy (a coach message sent after the backup, a photo added
 * since). Only for the same people: an account (or a pairing) that is
 * someone else in the backup, or isn't in it, gets nothing of the other's.
 * A message keeps no text or photo, as when it is deleted; a message whose
 * id the backup uses goes under a new one (devices know a message by its
 * uuid).
 */
function keepGone(before) {
  const usersNow = new Map(db.prepare('SELECT id, username, created_at FROM users').all().map(u => [u.id, `${u.username}\n${u.created_at}`]));
  const same = id => id == null || (usersNow.has(id) && usersNow.get(id) === before.users.get(id));
  const pairsNow = new Map(db.prepare('SELECT id, coach_id, client_id FROM coach_clients').all().map(p => [p.id, p]));
  const samePairing = id => {
    const a = before.pairings.get(id), b = pairsNow.get(id);
    return !!(a && b && a.coach_id === b.coach_id && a.client_id === b.client_id && same(a.coach_id) && same(a.client_id));
  };
  const hasUuid = db.prepare('SELECT 1 FROM coach_messages WHERE uuid = ?');
  const insMessage = db.prepare(`INSERT OR IGNORE INTO coach_messages (id,uuid,pairing_id,sender_id,body,image_url,recommendation_id,read_at,created_at,updated_at,deleted_at)
    VALUES (CASE WHEN EXISTS (SELECT 1 FROM coach_messages WHERE id = @id) THEN NULL ELSE @id END,@uuid,@pairing_id,@sender_id,NULL,NULL,NULL,@read_at,@created_at,datetime('now'),COALESCE(@deleted_at, datetime('now')))`);
  for (const m of before.coach_messages) {
    if (!hasUuid.get(m.uuid) && samePairing(m.pairing_id) && same(m.sender_id)) insMessage.run(m);
  }
  for (const t of ['body_stat_media', 'set_media']) {
    const has = db.prepare(`SELECT 1 FROM ${t} WHERE id = ?`);
    const cols = db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name).filter(c => c !== 'updated_at' && c !== 'deleted_at');
    // updated_at left to the trigger (now), so devices pull it.
    const ins = db.prepare(`INSERT OR IGNORE INTO ${t} (${cols.join(',')},deleted_at) VALUES (${cols.map(c => '@' + c).join(',')},COALESCE(@deleted_at, datetime('now')))`);
    for (const r of before[t]) {
      if (has.get(r.id) || !same(r.user_id)) continue;
      ins.run({ ...Object.fromEntries(cols.map(c => [c, null])), ...r });
    }
  }
}

// The exercises of a row (its `exercises` JSON), parsed; [] when there is none.
function _entriesOf(row) {
  try { const list = JSON.parse(row?.exercises || '[]'); return Array.isArray(list) ? list : []; }
  catch { return []; }
}

/**
 * Put back the backup's workout tombstones, then drop every tombstone that
 * names an exercise or set the restored workouts and workout days hold: the
 * merge (lib/workout-merge.js) drops a tombstoned entry from the row on its
 * next save, so a deletion made after the backup would undo the restore.
 * Scoped as the merge reads them: a workout's by its user, date and id (0,
 * from before sessions had ids: every workout of that user and date); a
 * workout day's by `date` 'template:<id>'. `rows`: absent in a backup from
 * before they were kept.
 */
function restoreTombstones(rows) {
  // Already here: the same one, or the same entry's with or without its
  // workout's id (0: from before sessions had ids). Start-up gives a 0 one
  // its workout's id (db.js), which two copies would make clash.
  const has = db.prepare(`SELECT 1 FROM workout_tombstones WHERE user_id IS @user_id AND date = @date AND kind = @kind AND ex_uuid = @ex_uuid AND uuid = @uuid
    AND (workout_id = @workout_id OR (kind IN ('exercise', 'set') AND (workout_id = 0 OR @workout_id = 0)))`);
  const ins = db.prepare(`INSERT INTO workout_tombstones (user_id,date,workout_id,kind,ex_uuid,uuid,deleted_at) VALUES (@user_id,@date,@workout_id,@kind,@ex_uuid,@uuid,COALESCE(@deleted_at, datetime('now')))`);
  for (const t of Array.isArray(rows) ? rows : []) {
    if (!t || typeof t.date !== 'string' || typeof t.kind !== 'string' || typeof t.uuid !== 'string') continue;
    const row = { user_id: t.user_id ?? null, date: t.date, workout_id: Number(t.workout_id) || 0, kind: t.kind, ex_uuid: t.ex_uuid || '', uuid: t.uuid, deleted_at: t.deleted_at || null };
    if (!has.get(row)) ins.run(row);
  }

  const cache = new Map();
  const entries = (key, load) => { if (!cache.has(key)) cache.set(key, load()); return cache.get(key); };
  const workoutsOn = db.prepare(`SELECT id, exercises FROM workout_log WHERE user_id IS ? AND date = ?`);
  const workoutOf = db.prepare(`SELECT id, exercises FROM workout_log WHERE id = ? AND user_id IS ? AND date = ?`);
  const dayOf = db.prepare(`SELECT exercises FROM workout_templates WHERE id = ?`);
  const holds = (list, t) => (t.kind === 'exercise' || t.kind === 'template_exercise')
    ? list.some(e => e?.uuid === t.uuid)
    : list.some(e => e?.uuid === t.ex_uuid && Array.isArray(e.sets) && e.sets.some(s => s?.uuid === t.uuid));
  const drop = db.prepare(`DELETE FROM workout_tombstones WHERE rowid = ?`);
  for (const t of db.prepare(`SELECT rowid AS rid, * FROM workout_tombstones`).all()) {
    let lists = [];
    if (t.kind === 'template_exercise' || t.kind === 'template_set') {
      const id = /^template:(\d+)$/.exec(t.date)?.[1];
      if (id) lists = [entries(`t${id}`, () => _entriesOf(dayOf.get(Number(id))))];
    } else if (t.kind === 'exercise' || t.kind === 'set') {
      const ids = t.workout_id
        ? workoutOf.all(t.workout_id, t.user_id, t.date)
        : workoutsOn.all(t.user_id, t.date);
      lists = ids.map(r => entries(`w${r.id}`, () => _entriesOf(r)));
    }
    if (lists.some(list => holds(list, t))) drop.run(t.rid);
  }
}

function dumpDatabase() {
  // OIDC tables may be missing on installs that haven't run the new schema
  // yet — guard so an admin can still take a backup mid-upgrade.
  const safe = (sql) => { try { return db.prepare(sql).all(); } catch { return []; } };
  return {
    users:               db.prepare('SELECT * FROM users').all(),
    exercises:           db.prepare('SELECT * FROM exercises').all(),
    programs:            db.prepare('SELECT * FROM programs').all(),
    workout_templates:   db.prepare('SELECT * FROM workout_templates').all(),
    program_assignments: db.prepare('SELECT * FROM program_assignments').all(),
    coach_prescriptions: db.prepare('SELECT * FROM coach_prescriptions').all(),
    coach_feedback:      safe('SELECT * FROM coach_feedback'),
    coach_activity:      safe('SELECT * FROM coach_activity'),
    coach_clients:       safe('SELECT * FROM coach_clients'),
    coach_messages:      safe('SELECT * FROM coach_messages'),
    workout_log:         db.prepare('SELECT * FROM workout_log').all(),
    workout_tombstones:  safe('SELECT * FROM workout_tombstones'),
    body_stats_log:      db.prepare('SELECT * FROM body_stats_log').all(),
    body_stat_media:     safe('SELECT * FROM body_stat_media'),
    set_media:           safe('SELECT * FROM set_media'),
    cardio_log:          safe('SELECT * FROM cardio_log'),
    excused_days:        safe('SELECT * FROM excused_days'),
    user_settings:       db.prepare('SELECT * FROM user_settings').all(),
    app_config:          db.prepare('SELECT * FROM app_config').all(),
    ai_chat_history:     db.prepare('SELECT * FROM ai_chat_history').all(),
    password_reset_tokens: db.prepare('SELECT * FROM password_reset_tokens').all(),
    invite_tokens:       db.prepare('SELECT * FROM invite_tokens').all(),
    // Integrations set up by hand: API tokens (hashed) and webhooks.
    api_tokens:          safe('SELECT * FROM api_tokens'),
    webhooks:            safe('SELECT * FROM webhooks'),
    oidc_providers:      safe('SELECT * FROM oidc_providers'),
    user_oidc_links:     safe('SELECT * FROM user_oidc_links'),
    // Two-step sign-in (nutritrace#222): secrets stay locked with this
    // server's two-step key, which is never in the archive; recovery codes
    // are hashes.
    user_two_step:   db.prepare('SELECT * FROM user_two_step').all(),
    user_two_step_recovery: db.prepare('SELECT * FROM user_two_step_recovery').all(),
  };
}

router.post('/', requireAdmin, (req, res) => {
  try {
    res.json(createBackup());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Auto-backup schedule (admin-only).
router.get('/schedule', requireAdmin, (req, res) => {
  try { res.json(getScheduleConfig()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
router.put('/schedule', requireAdmin, (req, res) => {
  try { res.json(setScheduleConfig(req.body || {})); }
  catch (err) {
    const status = err.code === 'ENV_LOCKED' ? 409 : 400;
    res.status(status).json({ error: err.message });
  }
});

router.get('/', requireAdmin, (req, res) => {
  try {
    const files = fs.readdirSync(BACKUPS_DIR).filter(f => f.endsWith('.zip')).map(f => {
      const stat = fs.statSync(path.join(BACKUPS_DIR, f));
      return { filename: f, size: stat.size, createdAt: stat.mtime.toISOString() };
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    res.json(files);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Extension guard — these routes operate on filenames in BACKUPS_DIR. Without
// the guard a crafted ":name" could reference any uploaded file (e.g. an
// attacker who got a JPG into uploads/ could ask the server to download or
// delete it via the backup endpoint).
function _backupFilename(name) {
  const filename = path.basename(name || '');
  if (!filename.endsWith('.zip')) return null;
  return filename;
}

router.get('/:name/download', requireAdmin, (req, res) => {
  const filename = _backupFilename(req.params.name);
  if (!filename) return res.status(400).json({ error: 'Invalid backup name' });
  const filePath = path.join(BACKUPS_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  res.download(filePath, filename);
});

router.delete('/:name', requireAdmin, (req, res) => {
  const filename = _backupFilename(req.params.name);
  if (!filename) return res.status(400).json({ error: 'Invalid backup name' });
  const filePath = path.join(BACKUPS_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  fs.unlinkSync(filePath);
  res.json({ ok: true });
});

router.post('/:name/restore', requireAdmin, (req, res) => {
  const filename = _backupFilename(req.params.name);
  if (!filename) return res.status(400).json({ error: 'Invalid backup name' });
  const filePath = path.join(BACKUPS_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  try { restoreFromZip(new AdmZip(filePath)); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/upload-restore', requireAdmin, upload.single('backup'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try { restoreFromZip(new AdmZip(req.file.path)); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
  finally { try { fs.unlinkSync(req.file.path); } catch {} }
});

export default router;
