import express from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import AdmZip from 'adm-zip';
import multer from 'multer';
import db from '../db.js';
import { logger } from '../logger.js';
import { seedSmtpFromEnv } from '../email.js';
import { seedAiFromEnv } from '../ai.js';

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
  return {
    schedule, time, retention,
    lastAutoRun:   _cfg('backup_last_auto_run')   || null,
    lastAutoError: _cfg('backup_last_auto_error') || null,
    envLocked:     isBackupEnvLocked(),
  };
}

export function setScheduleConfig({ schedule, time, retention }) {
  if (isBackupEnvLocked()) {
    const err = new Error('Backup schedule is locked by environment variable');
    err.code = 'ENV_LOCKED';
    throw err;
  }
  if (schedule != null) {
    if (!SCHEDULES.has(schedule)) throw new Error('schedule must be one of: off, daily, weekly, monthly');
    _setCfg('backup_schedule', schedule);
  }
  if (time != null) {
    if (!/^\d{1,2}:\d{2}$/.test(time)) throw new Error('time must be HH:MM');
    const [h, m] = time.split(':').map(n => parseInt(n, 10));
    if (h < 0 || h > 23 || m < 0 || m > 59) throw new Error('time out of range');
    _setCfg('backup_time', `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
  }
  if (retention != null) {
    const r = parseInt(retention, 10);
    if (!Number.isFinite(r) || r < 1 || r > 99) throw new Error('retention must be 1-99');
    _setCfg('backup_retention', String(r));
  }
  return getScheduleConfig();
}

export function createBackup() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename  = `lifttrace-backup-${timestamp}.zip`;
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
  return { filename, size: stat.size, createdAt: new Date().toISOString() };
}

export function pruneOldBackups(retention) {
  const keep = Math.max(1, Math.min(99, parseInt(retention, 10) || DEFAULT_RETENTION));
  const all = fs.readdirSync(BACKUPS_DIR)
    .filter(f => f.startsWith('lifttrace-backup-') && f.endsWith('.zip'))
    .sort()
    .reverse();
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
  db.transaction(() => {
    db.prepare('DELETE FROM password_reset_tokens').run();
    db.prepare('DELETE FROM invite_tokens').run();
    db.prepare('DELETE FROM user_settings').run();
    db.prepare('DELETE FROM app_config').run();
    db.prepare('DELETE FROM workout_log').run();
    db.prepare('DELETE FROM body_stats_log').run();
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

    // Restore custom exercises (user-created, not global seeds)
    const insExercise = db.prepare(`INSERT OR IGNORE INTO exercises (id,name,category,primary_muscles,secondary_muscles,equipment,instructions,tips,img_url,gif_url,video_url,external_id,source,is_global,created_by,created_at) VALUES (@id,@name,@category,@primary_muscles,@secondary_muscles,@equipment,@instructions,@tips,@img_url,@gif_url,@video_url,@external_id,@source,@is_global,@created_by,@created_at)`);
    for (const e of data.exercises || []) insExercise.run(e);

    const insProgram = db.prepare(`INSERT OR IGNORE INTO programs (id,name,description,goal,created_by,visibility,created_at,duration_weeks,advance_mode,on_complete) VALUES (@id,@name,@description,@goal,@created_by,@visibility,@created_at,@duration_weeks,@advance_mode,@on_complete)`);
    for (const p of data.programs || []) insProgram.run(_withProgramDefaults(p));

    const insTemplate = db.prepare(`INSERT OR IGNORE INTO workout_templates (id,program_id,name,day_label,order_index,exercises,created_at) VALUES (@id,@program_id,@name,@day_label,@order_index,@exercises,@created_at)`);
    for (const t of data.workout_templates || []) insTemplate.run(t);

    const insAssign = db.prepare(`INSERT OR IGNORE INTO program_assignments (id,program_id,assigned_to,assigned_by,start_date,active,assigned_at,week_cursor,week_cursor_session_base,week_cursor_pinned_at) VALUES (@id,@program_id,@assigned_to,@assigned_by,@start_date,@active,@assigned_at,@week_cursor,@week_cursor_session_base,@week_cursor_pinned_at)`);
    for (const a of data.program_assignments || []) insAssign.run(_withAssignDefaults(a));

    const insPrescription = db.prepare(`INSERT OR IGNORE INTO coach_prescriptions (id,trainer_id,member_id,date,template_id,name,exercises,notes,created_at) VALUES (@id,@trainer_id,@member_id,@date,@template_id,@name,@exercises,@notes,@created_at)`);
    for (const cp of data.coach_prescriptions || []) insPrescription.run(cp);

    const insWorkout = db.prepare(`INSERT OR IGNORE INTO workout_log (id,user_id,date,template_id,program_id,name,exercises,notes,duration_min,completed,created_at,program_week) VALUES (@id,@user_id,@date,@template_id,@program_id,@name,@exercises,@notes,@duration_min,@completed,@created_at,@program_week)`);
    for (const w of data.workout_log || []) insWorkout.run(_withField(w, 'program_week'));

    // Coach feedback: trainer notes on member workouts, plus the member's
    // read-receipt (seen_by_member_at) and single reply (member_reply /
    // member_replied_at). Round-trip everything so the feedback loop
    // survives restore. Must run AFTER workout_log insert because
    // coach_feedback.workout_id references workout_log(id). Legacy backups
    // predate these columns, so default them to NULL via _withField.
    // The earlier DELETE FROM users cascades and already emptied this table;
    // the DELETE here is defensive in case that cascade path ever changes.
    db.prepare('DELETE FROM coach_feedback').run();
    const insFeedback = db.prepare(`INSERT OR IGNORE INTO coach_feedback (id,trainer_id,member_id,workout_id,exercise_idx,note,created_at,updated_at,seen_by_member_at,member_reply,member_replied_at) VALUES (@id,@trainer_id,@member_id,@workout_id,@exercise_idx,@note,@created_at,@updated_at,@seen_by_member_at,@member_reply,@member_replied_at)`);
    for (const f of data.coach_feedback || []) {
      const row = _withField(_withField(_withField(_withField(_withField(f,
        'updated_at'), 'seen_by_member_at'), 'member_reply'), 'member_replied_at'), 'exercise_idx');
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

    const insBody = db.prepare(`INSERT OR IGNORE INTO body_stats_log (id,user_id,date,stats) VALUES (@id,@user_id,@date,@stats)`);
    for (const b of data.body_stats_log || []) insBody.run(b);

    const insSettings = db.prepare(`INSERT OR IGNORE INTO user_settings (user_id,key,value) VALUES (@user_id,@key,@value)`);
    for (const s of data.user_settings || []) insSettings.run(s);

    const insConfig = db.prepare(`INSERT OR REPLACE INTO app_config (key,value) VALUES (@key,@value)`);
    for (const c of data.app_config || []) insConfig.run(c);

    db.prepare('DELETE FROM ai_chat_history').run();
    const insChat = db.prepare(`INSERT OR IGNORE INTO ai_chat_history (id,user_id,role,content,created_at) VALUES (@id,@user_id,@role,@content,@created_at)`);
    for (const m of data.ai_chat_history || []) insChat.run(m);

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
  })();

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
    workout_log:         db.prepare('SELECT * FROM workout_log').all(),
    body_stats_log:      db.prepare('SELECT * FROM body_stats_log').all(),
    user_settings:       db.prepare('SELECT * FROM user_settings').all(),
    app_config:          db.prepare('SELECT * FROM app_config').all(),
    ai_chat_history:     db.prepare('SELECT * FROM ai_chat_history').all(),
    password_reset_tokens: db.prepare('SELECT * FROM password_reset_tokens').all(),
    invite_tokens:       db.prepare('SELECT * FROM invite_tokens').all(),
    oidc_providers:      safe('SELECT * FROM oidc_providers'),
    user_oidc_links:     safe('SELECT * FROM user_oidc_links'),
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
