/**
 * Only LiftTrace itself, and the addresses in FRAME_ANCESTORS, may show it
 * in a frame, so another site can't frame it to trick a click.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { framingHeaders, frameAncestorsDirective, parseFrameAncestors } from '../server/lib/frame-ancestors.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('by default only LiftTrace may frame itself', () => {
  for (const v of [undefined, '', '   ']) {
    assert.deepEqual(framingHeaders(v), { 'Content-Security-Policy': "frame-ancestors 'self'", 'X-Frame-Options': 'SAMEORIGIN' });
    assert.equal(frameAncestorsDirective(v), "frame-ancestors 'self'");
  }
});

test('FRAME_ANCESTORS adds origins, and then only the CSP header is sent', () => {
  assert.deepEqual(framingHeaders('https://home.example.com, https://*.example.org:8443'),
    { 'Content-Security-Policy': "frame-ancestors 'self' https://home.example.com https://*.example.org:8443" });
});

test('each entry becomes an origin, or is left out saying why', () => {
  const p = (v) => parseFrameAncestors(v);
  // A pasted page address is cut to its origin, and the warning says so.
  assert.deepEqual(p('https://ha.lan:8123/lovelace/0?kiosk'), { allowed: ['https://ha.lan:8123'], warnings: ['https://ha.lan:8123/lovelace/0?kiosk: has a path: using https://ha.lan:8123'] });
  assert.deepEqual(p('https://dash.lan/').allowed, ['https://dash.lan'], 'a trailing slash is no path');
  // Quotes, scheme case, default ports and duplicates.
  assert.deepEqual(p(`"https://a.lan" 'HTTPS://A.LAN:443' HTTP://b.lan:80 http://b.lan`).allowed, ['https://a.lan', 'http://b.lan']);
  // Wildcard subdomains, but never a whole top-level domain.
  assert.deepEqual(p('https://*.Example.com:*/x').allowed, ['https://*.example.com:*']);
  assert.deepEqual(p('https://*.com'), { allowed: [], warnings: ['https://*.com: too broad'] });
  // Ports: any, a number in range, or the entry is not an address.
  assert.deepEqual(p('http://10.0.0.5:3000 https://h.lan:* https://h.lan:70000 https://h.lan:0').allowed, ['http://10.0.0.5:3000', 'https://h.lan:*']);
  // IPv6 literals, as the URL parser writes them.
  assert.deepEqual(p('https://[::1]:8443').allowed, ['https://[::1]:8443']);
  // Anything else is left out, never written into the header.
  const bad = p("* 'self' 'unsafe-inline' javascript:alert(1) data: ftp://f.lan https://ok.lan;frame-src x https://user:pw@h.lan");
  assert.deepEqual(bad.allowed, []);
  assert.deepEqual(bad.warnings, [
    '*: not an address', "'self': not an address", "'unsafe-inline': not an address", 'javascript:alert(1): not http or https',
    'data:: not http or https', 'ftp://f.lan: not http or https', 'https://ok.lan;frame-src: not an address', 'x: not an address',
    'https://user:pw@h.lan: not an address',
  ]);
  assert.deepEqual(framingHeaders('*'), framingHeaders(''), 'a bare * is not accepted: it would allow every site');
});

test('the list is capped at 32 entries and 4 KB, with a warning', () => {
  const many = Array.from({ length: 40 }, (_, i) => `https://h${i}.lan`).join(' ');
  const r = parseFrameAncestors(many);
  assert.equal(r.allowed.length, 32);
  assert.equal(r.warnings.length, 8);
  assert.match(r.warnings[0], /^https:\/\/h32\.lan: too many addresses, kept the first 32$/);
  const long = Array.from({ length: 20 }, (_, i) => `https://${'a'.repeat(240)}${i}.lan`).join(' ');
  assert.ok(frameAncestorsDirective(long).length <= 4096 + 30);
});

test('the server sends them first, before anything that can answer or refuse a body', () => {
  const src = read('../server/index.js');
  assert.match(src, /const FRAMING = framingHeaders\(process\.env\.FRAME_ANCESTORS\);/);
  assert.match(src, /for \(const w of parseFrameAncestors\(process\.env\.FRAME_ANCESTORS\)\.warnings\) console\.warn/);
  const at = src.indexOf('router.use((req, res, next) => { res.set(FRAMING); next(); });');
  assert.ok(at > 0);
  assert.ok(at < src.indexOf('express.json('), 'above the body parsers');
  assert.ok(at < src.indexOf("res.vary('Origin')"), 'above CORS');
  assert.ok(at < src.indexOf('router.use(crossSiteGuard('), 'above the cross-site guard');
});

test('routes with their own Content-Security-Policy carry the framing rule too', async () => {
  for (const f of ['../server/routes/radio-proxy.js', '../server/routes/subsonic-proxy.js']) {
    assert.match(read(f), /'Content-Security-Policy', `default-src 'none';[^`]*sandbox; \$\{frameAncestorsDirective\(process\.env\.FRAME_ANCESTORS\)\}`/, f);
  }
  const saved = process.env.FRAME_ANCESTORS;
  try {
    delete process.env.FRAME_ANCESTORS;
    let { UPLOAD_RESPONSE_HEADERS: h } = await import('../server/lib/upload-paths.js?unset');
    assert.match(h['Content-Security-Policy'], /; sandbox; frame-ancestors 'self'$/);
    process.env.FRAME_ANCESTORS = 'https://home.example.com/board';
    ({ UPLOAD_RESPONSE_HEADERS: h } = await import('../server/lib/upload-paths.js?set'));
    assert.match(h['Content-Security-Policy'], /; sandbox; frame-ancestors 'self' https:\/\/home\.example\.com$/);
  } finally {
    if (saved === undefined) delete process.env.FRAME_ANCESTORS; else process.env.FRAME_ANCESTORS = saved;
  }
});
