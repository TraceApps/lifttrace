/**
 * Create keys past 30 days go while the server runs, not only at start
 * (#134). server/lib/create-keys.js pruned them once, when the server
 * started, so a server left running for months kept every key it noted,
 * and a delete by key with a fresh key notes one too. Now the next key
 * noted prunes, at most once an hour, with the same age rule, and nothing
 * wakes up on a timer just for this.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

// server/db.js opens DB_PATH when imported: a scratch database.
let db = null, dir = null, keys = null;
try {
  const req = createRequire(new URL('../server/package.json', import.meta.url));
  const D = req('better-sqlite3');
  new D(':memory:').close();
  dir = mkdtempSync(join(tmpdir(), 'create-keys-prune-'));
  process.env.DB_PATH = join(dir, 'test.db');
  db = (await import('../server/db.js')).default;
  keys = await import('../server/lib/create-keys.js');
} catch { /* better-sqlite3 not built for this Node: the cases skip */ }
test.after(() => { try { db?.close(); } catch {} if (dir) rmSync(dir, { recursive: true, force: true }); });

const aged = (key, days) => db.prepare(`INSERT INTO create_keys (owner, client_key, table_name, row_id, created_at) VALUES ('solo', ?, 'cardio_log', 1, datetime('now', ?))`).run(key, `-${days} days`);
const has = (key) => !!db.prepare('SELECT 1 FROM create_keys WHERE client_key = ?').get(key);
const note = (key) => keys.rememberCreated({ body: { client_key: key } }, null, 'cardio_log', 7);

test('keys past 30 days go on a later write, at most once an hour', (t) => {
  if (!db) return t.skip('better-sqlite3 is not built for this Node');
  const realNow = Date.now;
  let ahead = 0;
  Date.now = () => realNow() + ahead;
  try {
    aged('old-key-0000000001', 31);
    aged('young-key-00000001', 29);
    // Pruned at start a moment ago: not again yet.
    note('fresh-key-00000001');
    assert.equal(has('old-key-0000000001'), true, 'not again within the hour');

    ahead = 61 * 60 * 1000;
    note('fresh-key-00000002');
    assert.equal(has('old-key-0000000001'), false, 'past 30 days: gone');
    assert.equal(has('young-key-00000001'), true, 'under 30 days: kept');
    assert.equal(has('fresh-key-00000001'), true);
    assert.equal(has('fresh-key-00000002'), true);

    // A delete by key notes one as well, and prunes the same way.
    aged('old-key-0000000002', 45);
    assert.deepEqual(keys.rowForKey(null, 'cardio_log', 'bykey-key-0000001'), { id: null });
    assert.equal(has('old-key-0000000002'), true, 'not again within the hour');
    ahead = 2 * 61 * 60 * 1000;
    assert.deepEqual(keys.rowForKey(null, 'cardio_log', 'bykey-key-0000002'), { id: null });
    assert.equal(has('old-key-0000000002'), false, 'past 30 days: gone');
    assert.equal(has('young-key-00000001'), true);
    assert.equal(has('bykey-key-0000001'), true);
  } finally {
    Date.now = realNow;
  }
});

test('no timer of its own', () => {
  const src = readFileSync(new URL('../server/lib/create-keys.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /\bset(Interval|Timeout)\s*\(/);
});
