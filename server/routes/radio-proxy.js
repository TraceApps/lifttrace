import { Router } from 'express';
import dns from 'dns/promises';
import net from 'net';
import { logger } from '../logger.js';

const router = Router();

// ── SSRF guard ──────────────────────────────────────────────────────────────
// The radio proxy fetches user-supplied URLs server-side. Without a guard a
// member could submit a station URL pointing at the cloud-metadata endpoint
// (169.254.169.254) and exfiltrate IAM credentials, or probe internal LAN
// services. Tiered defaults:
//   * Link-local / IPv6 link-local — ALWAYS blocked. Never legitimate.
//   * Loopback + RFC1918 + IPv6 ULA — blocked by default; opt out via
//     ALLOW_PRIVATE_RADIO_URLS=1 for self-hosters running internal Icecast
//     on the same LAN / Docker network.
const ALLOW_PRIVATE_RADIO_URLS =
  process.env.ALLOW_PRIVATE_RADIO_URLS === '1' ||
  process.env.ALLOW_PRIVATE_RADIO_URLS === 'true';
if (ALLOW_PRIVATE_RADIO_URLS) {
  logger.warn('[radio-proxy] ALLOW_PRIVATE_RADIO_URLS=1 — proxy will fetch private/loopback addresses. Disable in cloud deployments.');
}

function _isLinkLocalOrCloudMeta(ip) {
  if (net.isIPv4(ip)) return ip.startsWith('169.254.');
  if (net.isIPv6(ip)) {
    const lo = ip.toLowerCase();
    // fe80::/10 = fe80..febf in the first hextet
    if (/^fe[89ab]/.test(lo)) return true;
    // IPv4-mapped link-local (e.g. ::ffff:169.254.169.254)
    if (lo.startsWith('::ffff:169.254.')) return true;
  }
  return false;
}

function _isPrivateOrLoopback(ip) {
  if (net.isIPv4(ip)) {
    if (ip === '0.0.0.0') return true;
    if (ip.startsWith('127.')) return true;
    if (ip.startsWith('10.')) return true;
    if (ip.startsWith('192.168.')) return true;
    if (ip.startsWith('172.')) {
      const second = parseInt(ip.split('.')[1], 10);
      if (second >= 16 && second <= 31) return true;
    }
    return false;
  }
  if (net.isIPv6(ip)) {
    const lo = ip.toLowerCase();
    if (lo === '::1' || lo === '::' || lo === '0:0:0:0:0:0:0:1') return true;
    // Unique-local addresses fc00::/7 = fc00..fdff
    if (/^f[cd]/.test(lo)) return true;
    // IPv4-mapped private
    if (/^::ffff:(127|10|192\.168|172\.(1[6-9]|2[0-9]|3[01]))\./i.test(lo)) return true;
  }
  return false;
}

/**
 * Resolve the URL's hostname and reject anything that lands on a blocked IP.
 * Returns a parsed URL on success; throws Error with a friendly message on
 * failure. Caller should map to 400 / silent-skip as appropriate.
 *
 * Note on DNS rebinding: this function resolves once. A determined attacker
 * could DNS-rebind between this lookup and the fetch. For audio streams the
 * exfiltration surface is tiny (we return bytes to a single user who already
 * controls the URL), so we accept the residual risk.
 */
async function assertSafeUrl(url) {
  let parsed;
  try { parsed = new URL(url); }
  catch { throw new Error('Invalid URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only http and https URLs are allowed');
  }
  let address;
  try {
    const r = await dns.lookup(parsed.hostname, { all: false });
    address = r.address;
  } catch {
    throw new Error('Could not resolve host');
  }
  if (_isLinkLocalOrCloudMeta(address)) {
    throw new Error('Link-local / cloud-metadata addresses are not allowed');
  }
  if (!ALLOW_PRIVATE_RADIO_URLS && _isPrivateOrLoopback(address)) {
    throw new Error('Private / loopback addresses are blocked. Set ALLOW_PRIVATE_RADIO_URLS=1 to enable LAN streams.');
  }
  return parsed;
}

// ── Now-playing cache (keyed by upstream URL) ───────────────────────────────
// Icecast/Shoutcast streams embed track metadata interleaved with audio bytes.
// We request Icy-MetaData: 1, parse the StreamTitle out of the byte stream,
// strip the metadata blocks before sending clean audio to the client, and
// cache the latest title so /now-playing can return it by URL.
const icyTitles = new Map();    // url -> { title, updatedAt, source }
const fallbackTries = new Map(); // url -> last-attempt timestamp
const FALLBACK_DEBOUNCE_MS = 30_000;

// ── Title sanitization ─────────────────────────────────────────────────────
// Handles the messy real-world payloads radio servers send:
//   * UTF-8 mojibake → retry as Latin-1 / Windows-1252
//   * HTML entities (&amp;, &#39;, &#x2013;, …)
//   * Embedded Shoutcast key=value payloads (title=Song;artist=Artist;…)
//   * Unicode dashes normalized to ASCII hyphen
//   * Control chars stripped
//   * Obvious ad-break markers returned as empty (so UI falls back to the
//     station's genre rather than showing "Advertisement")
function _sanitizeTitle(raw) {
  if (!raw) return '';
  let s = String(raw).replace(/\0+/g, '').trim();

  // Mojibake heuristic: if we see \uFFFD replacement chars the upstream is
  // probably Latin-1 / Windows-1252 and our UTF-8 decode failed. Re-interpret
  // the raw bytes as latin1 and keep whichever looks cleaner.
  if (/\uFFFD/.test(s)) {
    try {
      const bytes = Buffer.from(raw, 'binary');
      const latin = bytes.toString('latin1');
      if (latin && !/\uFFFD/.test(latin)) s = latin;
    } catch {}
  }

  // Basic HTML entity decode
  s = s.replace(/&amp;/gi, '&')
       .replace(/&lt;/gi, '<')
       .replace(/&gt;/gi, '>')
       .replace(/&quot;/gi, '"')
       .replace(/&apos;/gi, "'")
       .replace(/&#39;/g, "'")
       .replace(/&#(\d+);/g,          (_, n) => String.fromCharCode(parseInt(n, 10)))
       .replace(/&#x([0-9a-f]+);/gi,  (_, n) => String.fromCharCode(parseInt(n, 16)));

  // RDS Italia + similar broadcasters use an asterisk-delimited payload:
  //   `Song*<title>*<artist>*<year>*<uuid>` (or `Spot*...` for ads which we
  // drop). Without this branch the whole asterisk dump would land on the
  // lockscreen verbatim.
  const star = s.match(/^(Song|Spot|Track|Music|News|Promo|Ad)\s*\*\s*([^*]*?)\s*\*\s*([^*]*?)\s*(?:\*|$)/i);
  // iHeart Radio's StreamTitle format (KIIS, Z100, etc.) is non-standard.
  // The artist sits BEFORE `text=` and the song is inside the quoted value:
  //   Fun. - text="We Are Young" song_spot="M" MediaBaseId="1827386" ...
  // Split on `text=` and keep both halves to reconstruct "Artist - Song".
  const iheart = s.match(/^(.*?)\s*\btext\s*=\s*"([^"]+)"/i);
  if (star) {
    const type   = star[1].toLowerCase();
    const title  = star[2].trim();
    const artist = star[3].trim();
    if (type === 'spot' || type === 'ad' || type === 'promo') return '';
    if (!title && !artist) return '';
    if (!title)       s = artist;
    else if (!artist) s = title;
    else              s = `${artist} - ${title}`;
  } else if (iheart) {
    const prefix  = iheart[1].replace(/[\s\-‐-―]+$/, '').trim();
    const textVal = iheart[2].trim();
    s = prefix ? `${prefix} - ${textVal}` : textVal;
  } else if (/\b(title|artist)\s*=/i.test(s)) {
    // Shoutcast embedded key=value pairs — pull out title/artist cleanly
    const title  = (s.match(/\btitle\s*=\s*["']?([^"';\r\n]+?)["';]?(?:;|$)/i) || [])[1];
    const artist = (s.match(/\bartist\s*=\s*["']?([^"';\r\n]+?)["';]?(?:;|$)/i) || [])[1];
    if (title && artist) s = `${artist.trim()} - ${title.trim()}`;
    else if (title)      s = title.trim();
    else if (artist)     s = artist.trim();
  }

  // Normalize various Unicode dashes / hyphens to plain "-"
  s = s.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-');
  // Collapse whitespace and strip control chars
  s = s.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim();

  // Ad-break / empty-slot markers → treat as "no metadata" so UI falls back
  // to the station's configured genre or the station name.
  const lower = s.toLowerCase();
  const adMarkers = [
    'advertisement', 'commercial break', 'commercial', 'ad break', 'ads',
    'intermission', 'station id', 'unknown', 'no program',
  ];
  if (adMarkers.includes(lower)) return '';

  return s.slice(0, 256);
}

/**
 * Pull a per-song artwork URL out of a raw StreamTitle. iHeart's format
 * embeds it as `amgArtworkURL="..."`. Other stations don't provide one.
 */
function _extractArtwork(raw) {
  if (!raw) return '';
  const m = String(raw).match(/amgArtworkURL\s*=\s*"([^"]+)"/i);
  return m ? m[1].trim() : '';
}

// ── Fallback metadata fetchers ──────────────────────────────────────────────
// When a station isn't sending inline ICY metadata (or we can't read it for
// some reason), try the station server's out-of-band status endpoints:
//   * Icecast:   <origin>/status-json.xsl
//   * Shoutcast: <origin>/stats?json=1
// Both are server-to-server from our Node proxy so CORS doesn't matter. Runs
// at most once per 30s per URL. Silently no-ops on failure.
async function _tryFallbackFetchers(url) {
  const last = fallbackTries.get(url) || 0;
  if (Date.now() - last < FALLBACK_DEBOUNCE_MS) return;
  fallbackTries.set(url, Date.now());

  let parsed;
  try { parsed = new URL(url); } catch { return; }
  const origin = parsed.origin;
  const pathname = parsed.pathname;

  // SSRF guard — silent skip on disallowed hosts (this is a fire-and-
  // forget background fetch; no error to surface to the client).
  try { await assertSafeUrl(origin); } catch { return; }

  // ── Icecast status-json.xsl ─────────────────────────────────────────────
  try {
    const r = await fetch(`${origin}/status-json.xsl`, {
      headers: { 'User-Agent': 'LiftTrace-RadioProxy/1.0' },
      signal: AbortSignal.timeout(4500),
    });
    if (r.ok) {
      const data = await r.json();
      const sources = data?.icestats?.source;
      const list = Array.isArray(sources) ? sources : (sources ? [sources] : []);
      // Prefer the source whose listenurl path matches ours
      const matched = list.find(s => {
        try { return new URL(s.listenurl || '').pathname === pathname; }
        catch { return false; }
      }) || list[0];
      const rawTitle = matched?.title || matched?.yp_currently_playing || matched?.song || '';
      const clean = _sanitizeTitle(rawTitle);
      if (clean) {
        icyTitles.set(url, { title: clean, updatedAt: Date.now(), source: 'icecast-json' });
        return;
      }
    }
  } catch {}

  // ── Shoutcast v2 /stats?json=1 ──────────────────────────────────────────
  try {
    const r = await fetch(`${origin}/stats?json=1`, {
      headers: { 'User-Agent': 'LiftTrace-RadioProxy/1.0' },
      signal: AbortSignal.timeout(4500),
    });
    if (r.ok) {
      const data = await r.json();
      const rawTitle = data?.songtitle || data?.songTitle || '';
      const clean = _sanitizeTitle(rawTitle);
      if (clean) {
        icyTitles.set(url, { title: clean, updatedAt: Date.now(), source: 'shoutcast-json' });
        return;
      }
    }
  } catch {}
}

// ── Playlist file resolution (.pls / .m3u → first stream URL) ───────────────
async function resolvePlaylist(url) {
  if (!/\.(pls|m3u)(\?|$)/i.test(url)) return url;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'LiftTrace-RadioProxy/1.0' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return url;
    const text = await res.text();
    // .pls: File1=http://…
    const pls = text.match(/^\s*File\d+\s*=\s*(https?:\/\/\S+)/mi);
    if (pls) return pls[1].trim();
    // .m3u: first non-# line that's a URL
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (t && !t.startsWith('#') && /^https?:/i.test(t)) return t;
    }
    return url;
  } catch { return url; }
}

// ── Main stream proxy ───────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url required' });
  // SSRF guard — verify hostname before any fetch.
  try { await assertSafeUrl(url); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  try {
    const resolvedUrl = await resolvePlaylist(url);
    // After playlist resolution the URL may have changed — re-check.
    try { await assertSafeUrl(resolvedUrl); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    const upstream = await fetch(resolvedUrl, {
      headers: {
        'User-Agent': 'LiftTrace-RadioProxy/1.0',
        ...(req.headers.range ? { Range: req.headers.range } : {}),
        'Icy-MetaData': '1',
      },
    });

    res.status(upstream.status);
    const ct = upstream.headers.get('content-type');
    if (ct) res.setHeader('Content-Type', ct);
    const cl = upstream.headers.get('content-length');
    if (cl) res.setHeader('Content-Length', cl);
    const ar = upstream.headers.get('accept-ranges');
    if (ar) res.setHeader('Accept-Ranges', ar);
    const cr = upstream.headers.get('content-range');
    if (cr) res.setHeader('Content-Range', cr);
    res.setHeader('Cache-Control', 'no-cache');

    if (!upstream.body) return res.end();

    const metaint = parseInt(upstream.headers.get('icy-metaint') || '0', 10);
    const reader = upstream.body.getReader();
    let closed = false;
    req.on('close', () => { closed = true; try { reader.cancel(); } catch {} });

    if (!metaint) {
      // No inline metadata — plain passthrough
      while (!closed) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.write(Buffer.from(value))) await new Promise(r => res.once('drain', r));
      }
      return res.end();
    }

    // Interleaved audio + metadata. Parse state machine.
    let audioBytes = 0;
    let mode = 'audio';        // 'audio' | 'metaLen' | 'meta'
    let metaLen = 0;
    let metaAcc = Buffer.alloc(0);
    let buf = Buffer.alloc(0);

    while (!closed) {
      const { done, value } = await reader.read();
      if (done) break;
      buf = Buffer.concat([buf, Buffer.from(value)]);

      while (buf.length > 0) {
        if (mode === 'audio') {
          const need = metaint - audioBytes;
          if (buf.length <= need) {
            if (!res.write(buf)) await new Promise(r => res.once('drain', r));
            audioBytes += buf.length;
            buf = Buffer.alloc(0);
          } else {
            if (!res.write(buf.subarray(0, need))) await new Promise(r => res.once('drain', r));
            buf = buf.subarray(need);
            audioBytes = 0;
            mode = 'metaLen';
          }
        } else if (mode === 'metaLen') {
          metaLen = buf[0] * 16;
          buf = buf.subarray(1);
          if (metaLen === 0) { mode = 'audio'; }
          else { metaAcc = Buffer.alloc(0); mode = 'meta'; }
        } else {
          const want = metaLen - metaAcc.length;
          if (buf.length < want) {
            metaAcc = Buffer.concat([metaAcc, buf]);
            buf = Buffer.alloc(0);
          } else {
            metaAcc = Buffer.concat([metaAcc, buf.subarray(0, want)]);
            buf = buf.subarray(want);
            const text = metaAcc.toString('utf8').replace(/\0+$/, '');
            const m = text.match(/StreamTitle\s*=\s*'([^']*)'/);
            if (m) {
              const title = _sanitizeTitle(m[1]);
              const artwork = _extractArtwork(m[1]);
              if (title) icyTitles.set(url, { title, artwork, updatedAt: Date.now(), source: 'icy-inline' });
            }
            metaAcc = Buffer.alloc(0);
            mode = 'audio';
          }
        }
      }
    }
    res.end();
  } catch(e) {
    logger.error('[radio-proxy] fetch error:', e.message);
    if (!res.headersSent) res.status(502).json({ error: e.message });
    else res.end();
  }
});

// ── Now-playing poll endpoint ───────────────────────────────────────────────
router.get('/now-playing', (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url required' });
  const entry = icyTitles.get(url);

  // Fire-and-forget fallback fetch if we don't have a fresh entry. Debounced
  // per-URL to avoid hammering the upstream on every 8s client poll. The
  // response returns whatever's currently cached; the next poll picks up
  // the fallback result if it succeeded.
  const fresh = entry && (Date.now() - entry.updatedAt < 60_000);
  if (!fresh) _tryFallbackFetchers(url).catch(() => {});

  if (!entry) return res.json({ title: '', artwork: '', updatedAt: 0 });
  // Stale entries expire after 15 minutes
  if (Date.now() - entry.updatedAt > 15 * 60 * 1000) {
    icyTitles.delete(url);
    return res.json({ title: '', artwork: '', updatedAt: 0 });
  }
  res.json({
    title: entry.title || '',
    artwork: entry.artwork || '',
    updatedAt: entry.updatedAt,
    source: entry.source,
  });
});

// ── Station info (quick ICY header probe — for auto-fill on Add dialog) ────
router.get('/info', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url required' });
  try { await assertSafeUrl(url); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  try {
    const resolvedUrl = await resolvePlaylist(url);
    try { await assertSafeUrl(resolvedUrl); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    const controller = new AbortController();
    const upstream = await fetch(resolvedUrl, {
      headers: {
        'User-Agent': 'LiftTrace-RadioProxy/1.0',
        'Icy-MetaData': '0',
      },
      signal: controller.signal,
    });
    const info = {
      name:    upstream.headers.get('icy-name') || '',
      genre:   upstream.headers.get('icy-genre') || '',
      bitrate: upstream.headers.get('icy-br') || '',
      url:     upstream.headers.get('icy-url') || '',
    };
    // Don't need the body — abort right after headers
    try { controller.abort(); } catch {}
    res.json(info);
  } catch(e) {
    logger.warn('[radio-proxy] info fetch failed:', e.message);
    res.json({ name: '', genre: '', bitrate: '', url: '' });
  }
});

// ── Icon suggestion ─────────────────────────────────────────────────────────
// Priority:
//   1. Parse HTML from the homepage for <link rel="apple-touch-icon"> or
//      <link rel="icon" sizes="...">. Pick the one with the largest
//      declared size, preferring apple-touch-icon. These are almost
//      always 180x180+ PNGs — what the site uses on iOS home screens.
//   2. /apple-touch-icon.png, /apple-touch-icon-precomposed.png
//   3. Google favicon sz=256 (last resort — often blurry)
async function _parseHtmlForIcon(pageUrl) {
  try {
    // SSRF guard — caller may pass arbitrary user-supplied URLs.
    try { await assertSafeUrl(pageUrl); } catch { return null; }
    const res = await fetch(pageUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LiftTrace/1.0)' },
      signal: AbortSignal.timeout(6000),
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const html = await res.text();
    const candidates = [];
    const linkRe = /<link[^>]*rel=["']?(apple-touch-icon(?:-precomposed)?|icon|shortcut icon)[^>]*>/gi;
    let m;
    while ((m = linkRe.exec(html)) !== null) {
      const tag = m[0];
      const href = (tag.match(/href=["']([^"']+)["']/i) || [])[1];
      if (!href) continue;
      const rel = (m[1] || '').toLowerCase();
      const sizesStr = (tag.match(/sizes=["']([^"']+)["']/i) || [])[1] || '';
      const sizeNum = parseInt((sizesStr.match(/(\d+)/) || [])[1] || '0', 10);
      // Apple-touch-icon is implicitly 180x180 minimum in modern browsers
      const effectiveSize = rel.startsWith('apple-touch-icon') ? Math.max(sizeNum, 180) : sizeNum;
      let absolute;
      try { absolute = new URL(href, res.url).toString(); } catch { continue; }
      // Skip .svg (beautiful but browsers render at wrong size in <img>) and data: URIs
      if (/^data:/i.test(absolute)) continue;
      candidates.push({ url: absolute, size: effectiveSize, apple: rel.startsWith('apple-touch-icon') });
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => (b.apple - a.apple) || (b.size - a.size));
    return candidates[0].url;
  } catch { return null; }
}

router.get('/icon-suggest', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.json({ iconUrl: '' });
  let parsed;
  try { parsed = new URL(url); } catch { return res.json({ iconUrl: '' }); }
  const domain = parsed.hostname;
  const origin = parsed.origin;

  // SSRF guard — never probe private/loopback/link-local even if the user
  // supplied them. Returns empty (no icon) silently rather than 400 since
  // the caller treats this as best-effort.
  try { await assertSafeUrl(origin); }
  catch { return res.json({ iconUrl: '' }); }

  // 1. Parse the homepage HTML (best quality — uses sizes metadata)
  const htmlIcon = await _parseHtmlForIcon(origin);
  if (htmlIcon) return res.json({ iconUrl: htmlIcon });

  // 2. Standard apple-touch-icon paths
  for (const path of ['/apple-touch-icon.png', '/apple-touch-icon-precomposed.png']) {
    try {
      const r = await fetch(`${origin}${path}`, { method: 'HEAD', signal: AbortSignal.timeout(3500) });
      if (r.ok) return res.json({ iconUrl: `${origin}${path}` });
    } catch {}
  }

  // 3. Last resort — tiny Google favicon
  return res.json({ iconUrl: `https://www.google.com/s2/favicons?domain=${domain}&sz=256` });
});

export default router;
