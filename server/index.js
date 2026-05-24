import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import proxyRoutes       from './routes/proxy.js';
import authRoutes        from './routes/auth.js';
import exercisesRoutes   from './routes/exercises.js';
import programsRoutes    from './routes/programs.js';
import templatesRoutes   from './routes/templates.js';
import workoutRoutes     from './routes/workout.js';
import statsRoutes       from './routes/stats.js';
import bodyStatsRoutes   from './routes/body-stats.js';
import uploadRoutes      from './routes/upload.js';
import settingsRoutes    from './routes/settings.js';
import appConfigRoutes   from './routes/app-config.js';
import aiRoutes          from './routes/ai.js';
import fullBackupRoutes  from './routes/full-backup.js';
import subsonicProxy     from './routes/subsonic-proxy.js';
import radioProxy        from './routes/radio-proxy.js';
import workoutImport     from './routes/workout-import.js';
import exerciseImport    from './routes/exercise-import.js';
import notifyRoutes      from './routes/notify.js';
import trainerRoutes     from './routes/trainer.js';
import prescriptionRoutes from './routes/prescriptions.js';
import coachFeedbackRoutes from './routes/coach-feedback.js';
import syncRoutes         from './routes/sync.js';
import oidcRoutes        from './routes/oidc.js';
import oidcAdminRoutes   from './routes/oidc-admin.js';
import { logger }        from './logger.js';
import { authenticate }  from './middleware/auth.js';
import { seedSmtpFromEnv } from './email.js';
import { seedAiFromEnv }   from './ai.js';
import { seedOidcFromEnv } from './lib/oidc-env.js';
import { autoSeed }        from './exercise-sources/index.js';
import { seedPrograms }    from './seed-templates.js';
import { startScheduler }  from './lib/scheduler.js';

// Initialise DB (runs schema)
import db from './db.js';

// Seed config from env vars
seedSmtpFromEnv();
seedAiFromEnv();
seedOidcFromEnv();

// Seed built-in programs (Monumental Valley, Shredville) on first startup
seedPrograms();

// Auto-seed exercises from wger (non-blocking)
autoSeed().catch(e => logger.warn('[seed] Auto-seed failed:', e.message));

// Start notification scheduler (15-min tick)
startScheduler();

const app  = express();
const PORT = process.env.PORT || 3003;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Reverse-proxy / subpath support ───────────────────────────────────────
// BASE_URL lets users mount LiftTrace at a path other than root, e.g. for
// `https://example.com/lifttrace/` set BASE_URL=/lifttrace. Empty string
// (default) keeps current root-mounted behavior — no migration needed for
// existing installs.
const BASE_URL = (process.env.BASE_URL || '').replace(/\/$/, '');
if (BASE_URL && !BASE_URL.startsWith('/')) {
  console.error(`[server] BASE_URL must start with '/' — got: ${BASE_URL}`);
  process.exit(1);
}
// Everything route-related goes on this router, mounted at BASE_URL or '/'.
const router = express.Router();

// Global JSON body limit defaults to 1 MB. The handful of routes that
// legitimately accept large bodies (full-backup restore, exercise import)
// use multer's multipart/file uploads with their own per-route caps, so
// they don't need the global JSON limit relaxed.
router.use(express.json({ limit: '1mb' }));
router.use(cookieParser());

// CORS — allow same-host + Capacitor origins
router.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    const host = req.get('host');
    const isCapacitor = origin === 'https://localhost' || origin === 'http://localhost';
    const isSameHost = host && origin.includes(host);
    if (isCapacitor || isSameHost) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    }
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

router.use(authenticate);

// Auto-capture public URL from first request (for email logos, invite links)
router.use((req, res, next) => {
  if (!db.prepare("SELECT 1 FROM app_config WHERE key='app_url'").get()) {
    const proto = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.get('host');
    if (host && !host.includes('localhost')) {
      db.prepare("INSERT OR REPLACE INTO app_config (key, value) VALUES ('app_url', ?)").run(`${proto}://${host}`);
      logger.info(`[app] Auto-detected public URL: ${proto}://${host}`);
    }
  }
  next();
});

// Request logging
router.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    const lvl = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    logger[lvl](`${req.method} ${req.path} → ${res.statusCode} (${ms}ms)`);
  });
  next();
});

// Static uploads — kept BEFORE auth so images are publicly readable
// (Android WebView can't send Authorization headers on <img src> requests).
const uploadsPath = process.env.UPLOADS_PATH || './uploads';
router.use('/uploads', express.static(uploadsPath, {
  setHeaders(res) { res.set('Cache-Control', 'public, max-age=3600'); }
}));

// No-cache API responses
router.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

// API routes
router.use('/api/auth/oidc',    oidcRoutes);
router.use('/api/admin/oidc',   oidcAdminRoutes);
router.use('/api/auth',         authRoutes);
router.use('/api/proxy',        proxyRoutes);
router.use('/api/exercises',    exercisesRoutes);
router.use('/api/programs',     programsRoutes);
router.use('/api/templates',    templatesRoutes);
router.use('/api/workout',      workoutRoutes);
router.use('/api/stats',        statsRoutes);
router.use('/api/body-stats',   bodyStatsRoutes);
router.use('/api/upload',       uploadRoutes);
router.use('/api/settings',     settingsRoutes);
router.use('/api/app-config',   appConfigRoutes);
router.use('/api/ai',           aiRoutes);
router.use('/api/full-backup',  fullBackupRoutes);
router.use('/api/subsonic',     subsonicProxy);
router.use('/api/radio-proxy',  radioProxy);
router.use('/api/workout-import', workoutImport);
router.use('/api/exercise-import', exerciseImport);
router.use('/api/notify',       notifyRoutes);
router.use('/api/trainer',      trainerRoutes);
router.use('/api/prescriptions', prescriptionRoutes);
router.use('/api/coach-feedback', coachFeedbackRoutes);
router.use('/api/sync',          syncRoutes);
router.get('/api/health', (req, res) => res.json({ ok: true }));

// Serve Svelte frontend (production build) — anything except index.html.
// Templated index.html (with __NT_CONFIG__ injected) handles the SPA fallback.
router.use(express.static(path.join(__dirname, 'dist'), {
  index: false,
  setHeaders(res, filePath) {
    if (filePath.includes('/assets/')) {
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
    } else {
      res.set('Cache-Control', 'no-cache');
    }
  }
}));

// Pre-template dist/index.html at startup, injecting window.__LT_CONFIG__ so
// the client knows its base path at runtime. Empty BASE_URL → empty basePath
// → behaviorally identical to a deploy without this feature.
const _indexHtmlPath = path.join(__dirname, 'dist', 'index.html');
let _indexHtmlTemplated = '';
try {
  const raw = fs.readFileSync(_indexHtmlPath, 'utf8');
  _indexHtmlTemplated = raw.replace(
    '</head>',
    `<script>window.__LT_CONFIG__ = { basePath: ${JSON.stringify(BASE_URL)} };</script></head>`
  );
} catch (e) {
  logger.warn(`[server] could not pre-template dist/index.html: ${e.message}`);
}

// SPA fallback — serves the templated index.html for any route under BASE_URL.
// Express 5 / path-to-regexp v8: unnamed `*` is no longer accepted; use a
// named splat.
router.get('/{*splat}', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  if (_indexHtmlTemplated) {
    res.set('Content-Type', 'text/html').send(_indexHtmlTemplated);
  } else {
    res.sendFile(_indexHtmlPath);
  }
});

// Mount the router at BASE_URL (or root if unset).
app.use(BASE_URL || '/', router);

// Global error handler
app.use((err, req, res, next) => {
  logger.error(`${req.method} ${req.path} — ${err.stack || err.message}`);
  if (!res.headersSent) {
    res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
  }
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection:', reason instanceof Error ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception:', err.stack || err.message);
  process.exit(1);
});

app.listen(PORT, () => logger.info(`LiftTrace running on port ${PORT}`));
