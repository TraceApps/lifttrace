import { Router } from 'express';
import { logger } from '../logger.js';
import { fetchChecked, readBody } from '../lib/ssrf-guard.js';

const router = Router();

const ALLOWED = ['wger.de', 'exercisedb.p.rapidapi.com'];

router.get('/', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const parsed = new URL(url);
    if (!ALLOWED.includes(parsed.hostname)) return res.status(403).json({ error: 'Domain not allowed' });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    // Only the allowed public hosts, and a redirect may not lead into the
    // server's own network or to cloud metadata.
    const response = await fetchChecked(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LiftTrace/1.0)' },
    }, { maxRedirects: 3 });
    if (!response.ok) {
      logger.warn(`[proxy] upstream ${response.status} for ${url}`);
      return res.status(response.status).json({ error: `Upstream ${response.status}` });
    }
    const body = JSON.parse((await readBody(response, 5 * 1024 * 1024)).toString('utf8'));
    clearTimeout(timer);
    res.json(body);
  } catch(e) {
    logger.error('[proxy] fetch error:', e.message);
    res.status(503).json({ error: 'Could not reach that service' });
  }
});

export default router;
