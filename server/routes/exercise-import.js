import { Router } from 'express';
import db from '../db.js';
import { wrap } from '../logger.js';
import { requireAuth, uid } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// Legacy XLSX routes removed alongside the Programs Excel-import
// feature. Catalog management (catalogs/*) endpoints below stay so
// anyone with old import:<name> rows can clean them up.
router.get('/template', (req, res) => {
  res.status(410).json({ error: 'Excel import is no longer supported. Use Custom Catalog (JSON) instead.' });
});
router.post('/import', (req, res) => {
  res.status(410).json({ error: 'Excel import is no longer supported. Use Custom Catalog (JSON) instead.' });
});

// ── Import custom catalog (JSON) ─────────────────────────────────────────────
// Body: { catalogName: string, exercises: [{ name, category?, primary_muscles?,
//         secondary_muscles?, equipment?, instructions?, img_url?, gif_url?,
//         video_url? }] }
// Each row gets source='import:<catalogName>' + is_global=0 + created_by=uid.
// Names are deduped within the import by lower-case + equipment pair.
// Returns { ok, count, duplicates, skipped, catalogName }.
router.post('/import-json', wrap((req, res) => {
  const userId = uid(req);
  const body = req.body || {};
  const catalogName = String(body.catalogName || '').trim();
  if (!catalogName) return res.status(400).json({ error: 'catalogName is required' });
  if (catalogName.length > 60) return res.status(400).json({ error: 'catalogName must be 60 characters or fewer' });
  const list = Array.isArray(body.exercises) ? body.exercises : null;
  if (!list) return res.status(400).json({ error: 'exercises must be an array' });
  if (list.length === 0) return res.status(400).json({ error: 'exercises array is empty' });
  if (list.length > 10000) return res.status(400).json({ error: 'exercises array exceeds 10,000 row cap' });

  const source = `import:${catalogName}`;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO exercises (name, category, equipment, instructions,
       primary_muscles, secondary_muscles, img_url, gif_url, video_url,
       source, is_global, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
  );

  const seen = new Set();
  let count = 0, duplicates = 0, skipped = 0;
  const _norm = s => String(s || '').trim().replace(/\s+/g, ' ');
  const _arr  = v => Array.isArray(v) ? v.filter(x => typeof x === 'string').map(_norm).filter(Boolean) : [];
  const _str  = v => (v == null || v === '') ? null : String(v);

  const tx = db.transaction(() => {
    for (const raw of list) {
      const name = _norm(raw?.name);
      if (!name) { skipped++; continue; }
      const equipment = _arr(raw?.equipment);
      const key = name.toLowerCase() + '||' + equipment.join(',').toLowerCase();
      if (seen.has(key)) { duplicates++; continue; }
      seen.add(key);
      try {
        insert.run(
          name,
          _str(raw?.category) || 'other',
          JSON.stringify(equipment),
          _str(raw?.instructions),
          JSON.stringify(_arr(raw?.primary_muscles)),
          JSON.stringify(_arr(raw?.secondary_muscles)),
          _str(raw?.img_url),
          _str(raw?.gif_url),
          _str(raw?.video_url),
          source,
          userId,
        );
        count++;
      } catch {
        skipped++;
      }
    }
  });
  try { tx(); } catch (e) {
    return res.status(500).json({ error: `Import failed: ${e.message}` });
  }

  res.json({ ok: true, catalogName, count, duplicates, skipped });
}));

// ── List imported catalogs ───────────────────────────────────────────────────
router.get('/catalogs', wrap((req, res) => {
  const rows = db.prepare(
    `SELECT source, COUNT(*) as count FROM exercises
     WHERE source LIKE 'import:%' GROUP BY source`
  ).all();
  const catalogs = rows.map(r => {
    const name = r.source.replace('import:', '');
    const disabled = db.prepare(
      `SELECT value FROM user_settings WHERE user_id = ? AND key = ?`
    ).get(uid(req), `catalog_disabled_${name}`);
    return { id: r.source, name, count: r.count, enabled: !disabled?.value || disabled.value === 'false' };
  });
  res.json(catalogs);
}));

// ── Toggle catalog enabled/disabled ──────────────────────────────────────────
router.post('/catalogs/toggle', wrap((req, res) => {
  const { name, enabled } = req.body;
  const userId = uid(req);
  const key = `catalog_disabled_${name}`;
  if (enabled) {
    db.prepare('DELETE FROM user_settings WHERE user_id = ? AND key = ?').run(userId, key);
  } else {
    db.prepare('INSERT OR REPLACE INTO user_settings (user_id, key, value) VALUES (?, ?, ?)').run(userId, key, 'true');
  }
  res.json({ ok: true });
}));

// ── Delete an imported catalog ───────────────────────────────────────────────
router.post('/catalogs/delete', wrap((req, res) => {
  const { name } = req.body;
  const source = `import:${name}`;
  const result = db.prepare('DELETE FROM exercises WHERE source = ?').run(source);
  // Clean up disabled flag
  db.prepare('DELETE FROM user_settings WHERE key = ?').run(`catalog_disabled_${name}`);
  res.json({ ok: true, removed: result.changes });
}));

export default router;
