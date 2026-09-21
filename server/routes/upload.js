import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { safeUploadExtension } from '../lib/upload-paths.js';
import { requireAuth } from '../middleware/auth.js';
import { assertAllowedMedia } from '../lib/image-magic.js';

const uploadsPath = process.env.UPLOADS_PATH || './uploads';
fs.mkdirSync(uploadsPath, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsPath),
  filename: (req, file, cb) => {
    const ext = safeUploadExtension(file.mimetype, file.originalname);
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Images only'));
  },
});

const router = Router();

router.post('/', requireAuth, (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) return next(err);
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    // Magic-byte validation — never trust the client-sent mimetype.
    // SVG is excluded by the allowlist (script-execution risk).
    try {
      const realMime = assertAllowedMedia(req.file.path, ['image']);
      res.json({ url: `/uploads/${req.file.filename}`, mimeType: realMime });
    } catch (e) {
      try { fs.unlinkSync(req.file.path); } catch {}
      res.status(400).json({ error: e.message });
    }
  });
});

// Exercise media upload — accepts images, GIFs, and videos. Larger size
// limits than the default image-only /api/upload route.
const exerciseMediaStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(uploadsPath, 'exercises');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = safeUploadExtension(file.mimetype, file.originalname);
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  },
});

const exerciseMediaUpload = multer({
  storage: exerciseMediaStorage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB — covers videos
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/');
    if (!ok) return cb(new Error('Images, GIFs, and videos only'));
    cb(null, true);
  },
});

router.post('/exercise-media', requireAuth, (req, res, next) => {
  exerciseMediaUpload.single('file')(req, res, (err) => {
    if (err) return next(err);
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    // Magic-byte validation — re-check actual bytes against known image
    // and video signatures. The client-sent MIME type is untrusted.
    let realMime;
    try { realMime = assertAllowedMedia(req.file.path, ['image', 'video']); }
    catch (e) {
      try { fs.unlinkSync(req.file.path); } catch {}
      return res.status(400).json({ error: e.message });
    }
    let kind = 'img';
    if (realMime === 'image/gif') kind = 'gif';
    else if (realMime.startsWith('video/')) kind = 'video';
    res.json({
      url: `/uploads/exercises/${req.file.filename}`,
      kind,
      mimeType: realMime,
      size: req.file.size,
    });
  });
});

// Progress-photo upload. Its own subdirectory rather than the uploads
// root so this feature's files stay identifiable for backup, cleanup and
// account deletion. Image-only and 20 MB: a phone camera JPEG runs 3 to
// 8 MB and a HEIC burst shot rarely tops 15, so this has headroom
// without inviting video-sized files into a photo timeline.
const bodyStatMediaStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(uploadsPath, 'body-stats');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = safeUploadExtension(file.mimetype, file.originalname);
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  },
});

const bodyStatMediaUpload = multer({
  storage: bodyStatMediaStorage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Images only'));
  },
});

// ── Set videos (issue #57) ───────────────────────────────────────────────
// A clip of one set, for technique review. Its own directory, kept out of
// the static tree (see PRIVATE_SUBDIRS in lib/upload-paths.js) because it is
// footage of someone in their gym, not a shared exercise demo.
//
// 200 MB is roughly a minute of phone video at default settings, and matches
// the only published cap in this corner of the market (TrueCoach's). Nothing
// is re-encoded here: adding ffmpeg to the image is a lot of machinery for a
// feature nobody has used yet, and no comparable product transcodes on
// ingest either. Clips filmed inside the app are recorded at a modest
// bitrate instead, which is where the size problem is actually solved.
const setVideoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(uploadsPath, 'set-videos');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = safeUploadExtension(file.mimetype, file.originalname);
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  },
});

const setVideoUpload = multer({
  storage: setVideoStorage,
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('video/')) cb(null, true);
    else cb(new Error('Videos only'));
  },
});

router.post('/set-video', requireAuth, (req, res, next) => {
  setVideoUpload.single('file')(req, res, (err) => {
    if (err) {
      // Multer's own size error is the one users will actually hit, so it
      // says what the limit is rather than "File too large".
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'That clip is over 200 MB. Film a shorter set, or record it in the app.' });
      }
      return next(err);
    }
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    try {
      const realMime = assertAllowedMedia(req.file.path, ['video']);
      res.json({
        url: `/uploads/set-videos/${req.file.filename}`,
        mimeType: realMime,
        sizeBytes: req.file.size,
      });
    } catch (e) {
      try { fs.unlinkSync(req.file.path); } catch {}
      res.status(400).json({ error: e.message });
    }
  });
});

router.post('/body-stats', requireAuth, (req, res, next) => {
  bodyStatMediaUpload.single('file')(req, res, (err) => {
    if (err) return next(err);
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    // Magic-byte validation, same as the routes above: the client-sent
    // mimetype is untrusted and SVG stays off the allowlist.
    try {
      const realMime = assertAllowedMedia(req.file.path, ['image']);
      res.json({ url: `/uploads/body-stats/${req.file.filename}`, mimeType: realMime });
    } catch (e) {
      try { fs.unlinkSync(req.file.path); } catch {}
      res.status(400).json({ error: e.message });
    }
  });
});

export default router;
