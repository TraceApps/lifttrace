/**
 * Pre-cache media for offline, behind a login proxy.
 *
 * The button fetched every exercise picture with credentials 'omit'. Behind
 * a reverse proxy that signs people in on another address (Authelia,
 * VoidAuth), the proxy answered a picture on this server with a redirect to
 * its sign-in page; the service worker kept that opaque answer in
 * uploads-cache, and the picture or video stayed broken, online too, for up
 * to 90 days. Behind basic auth the pictures got a 401 and were never kept.
 *
 * The same rule also kept an HTML page under a picture's address: a proxy's
 * sign-in on this address once its session ran out, or the app's own page
 * for a file that isn't there.
 *
 * These check the parts of the fix: the button sends the browser's own
 * credentials, the uploads rule keeps only a readable 200 that isn't a page,
 * and the pages already kept are swept out once.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('the pre-cache button keeps the browser\'s credentials', () => {
  const src = read('../src/components/settings/SettingsCatalog.svelte');
  const call = src.match(/async function precacheMedia\(\)[\s\S]*?await fetch\(urls\[myIdx\], (\{[^}]*\})\)/);
  assert.ok(call, 'precacheMedia fetch not found');
  assert.match(call[1], /mode: 'no-cors'/);
  assert.doesNotMatch(call[1], /credentials/);
});

test('uploads-cache keeps only a readable 200', () => {
  const cfg = read('../vite.config.js');
  const rule = cfg.match(/cacheName: 'uploads-cache',[\s\S]*?cacheableResponse: \{ statuses: \[([^\]]*)\] \}/);
  assert.ok(rule, 'uploads-cache rule not found');
  assert.deepEqual(rule[1].split(',').map(s => s.trim()), ['200']);
});

test('uploads-cache refuses a page', async () => {
  const cfg = read('../vite.config.js');
  const body = cfg.match(/cacheName: 'uploads-cache',[\s\S]*?cacheWillUpdate: (async \(\{ response \}\) =>[\s\S]*?: response),/);
  assert.ok(body, 'uploads-cache cacheWillUpdate not found');
  const willUpdate = (0, eval)(body[1]);
  const res = (type) => ({ headers: new Headers(type ? { 'Content-Type': type } : {}) });
  for (const t of ['text/html', 'text/html; charset=utf-8', 'TEXT/HTML']) assert.equal(await willUpdate({ response: res(t) }), null, t);
  for (const t of ['image/png', 'image/gif', 'video/mp4', 'application/octet-stream', null]) {
    const r = res(t);
    assert.equal(await willUpdate({ response: r }), r, String(t));
  }
});

test('main.js runs the sweep after the legacy purge', () => {
  const main = read('../src/main.js');
  assert.match(main, /purgeLegacyPhotoCache\(\)\.then\(purgePagesKeptAsPictures\)/);
});

function fakes(entries, { has = true, failOpen = false } = {}) {
  const entry = (type, contentType) => ({ type, headers: new Headers(contentType ? { 'Content-Type': contentType } : {}) });
  const store = new Map(entries.map(([url, type, contentType]) => [url, entry(type, contentType)]));
  const opened = [];
  globalThis.caches = {
    has: async (name) => has && name === 'uploads-cache',
    open: async (name) => {
      opened.push(name);
      if (failOpen) throw new Error('blocked');
      return {
        keys: async () => [...store.keys()].map(url => ({ url })),
        match: async (req) => store.get(req.url),
        delete: async (req) => store.delete(req.url),
      };
    },
  };
  const ls = new Map();
  globalThis.localStorage = { getItem: (k) => ls.get(k) ?? null, setItem: (k, v) => ls.set(k, String(v)) };
  return { store, opened, ls, entry };
}

const { purgePagesKeptAsPictures } = await import('../src/lib/uploads-cache.js');
const FLAG = 'lt:uploads-cache-pages-purged';

test('the sweep drops only opaque entries and pages, once', async () => {
  const f = fakes([
    ['http://x/uploads/exercises/a.png', 'basic', 'image/png'],
    ['http://x/uploads/exercises/b.png', 'opaque'],
    ['http://x/uploads/exercises/c.mp4', 'opaque'],
    ['http://x/uploads/exercises/d.png', 'basic', 'text/html; charset=utf-8'],
    ['http://x/uploads/exercises/e.mp4', 'basic', 'video/mp4'],
  ]);
  await purgePagesKeptAsPictures();
  assert.deepEqual([...f.store.keys()], ['http://x/uploads/exercises/a.png', 'http://x/uploads/exercises/e.mp4']);
  assert.equal(f.ls.get(FLAG), '1');

  f.store.set('http://x/uploads/exercises/d.png', f.entry('opaque'));
  await purgePagesKeptAsPictures();
  assert.ok(f.store.has('http://x/uploads/exercises/d.png'), 'ran a second time');
});

test('no uploads-cache: nothing opened, flag set', async () => {
  const f = fakes([], { has: false });
  await purgePagesKeptAsPictures();
  assert.deepEqual(f.opened, []);
  assert.equal(f.ls.get(FLAG), '1');
});

test('a cache that cannot be read is tried again next launch', async () => {
  const f = fakes([['http://x/uploads/a.png', 'opaque']], { failOpen: true });
  await purgePagesKeptAsPictures();
  assert.equal(f.ls.get(FLAG), undefined);
});
