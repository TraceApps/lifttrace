import express from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import AdmZip from 'adm-zip';
import multer from 'multer';
import db from '../db.js';
import { seedSmtpFromEnv } from '../email.js';
import { seedAiFromEnv } from '../ai.js';

const router = express.Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const UPLOADS_DIR = process.env.UPLOADS_PATH || path.resolve(__dirname, '..', 'uploads');
const BACKUPS_DIR = process.env.BACKUPS_PATH || path.join(UPLOADS_DIR, 'backups');
fs.mkdirSync(BACKUPS_DIR, { recursive: true });

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

    const insProgram = db.prepare(`INSERT OR IGNORE INTO programs (id,name,description,goal,created_by,visibility,created_at) VALUES (@id,@name,@description,@goal,@created_by,@visibility,@created_at)`);
    for (const p of data.programs || []) insProgram.run(p);

    const insTemplate = db.prepare(`INSERT OR IGNORE INTO workout_templates (id,program_id,name,day_label,order_index,exercises,created_at) VALUES (@id,@program_id,@name,@day_label,@order_index,@exercises,@created_at)`);
    for (const t of data.workout_templates || []) insTemplate.run(t);

    const insAssign = db.prepare(`INSERT OR IGNORE INTO program_assignments (id,program_id,assigned_to,assigned_by,start_date,active,assigned_at) VALUES (@id,@program_id,@assigned_to,@assigned_by,@start_date,@active,@assigned_at)`);
    for (const a of data.program_assignments || []) insAssign.run(a);

    const insPrescription = db.prepare(`INSERT OR IGNORE INTO coach_prescriptions (id,trainer_id,member_id,date,template_id,name,exercises,notes,created_at) VALUES (@id,@trainer_id,@member_id,@date,@template_id,@name,@exercises,@notes,@created_at)`);
    for (const cp of data.coach_prescriptions || []) insPrescription.run(cp);

    const insWorkout = db.prepare(`INSERT OR IGNORE INTO workout_log (id,user_id,date,template_id,program_id,name,exercises,notes,duration_min,completed,created_at) VALUES (@id,@user_id,@date,@template_id,@program_id,@name,@exercises,@notes,@duration_min,@completed,@created_at)`);
    for (const w of data.workout_log || []) insWorkout.run(w);

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
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `lifttrace-backup-${timestamp}.zip`;
    const destPath = path.join(BACKUPS_DIR, filename);
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
    res.json({ filename, size: stat.size, createdAt: new Date().toISOString() });
  } catch (err) { res.status(500).json({ error: err.message }); }
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
