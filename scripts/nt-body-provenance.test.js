/**
 * The NutriTrace body provenance claim, against the real SQLite storage.
 *
 * The client marker is only a cache: two tabs opened before the first import
 * both see it empty. These tests drive the server-side compare-and-set those
 * tabs actually hit, including two connections on the same database file
 * (the "two clients" case), and the check applied to each imported body write.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  claimProvenance,
  readProvenance,
  verifyProvenance,
  NT_BODY_PROVENANCE_KEY,
} from '../server/lib/nt-body-provenance.js';

const serverRequire = createRequire(new URL('../server/package.json', import.meta.url));
let Database = null;
try { Database = serverRequire('better-sqlite3'); } catch { /* server packages missing */ }
// The production driver may be built for another Node ABI in a scratch tree;
// node:sqlite is the same SQLite, so the CAS is exercised without it.
if (Database) {
  try { new Database(':memory:').close(); }
  catch { Database = null; }
}
if (!Database) {
  try { Database = (await import('node:sqlite')).DatabaseSync; } catch { Database = null; }
}
const skip = Database ? false : 'no SQLite driver available';

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'lt-provenance-'));
  const path = join(dir, 'lt.db');
  const open = () => {
    const db = new Database(path);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(`CREATE TABLE IF NOT EXISTS user_settings (
      user_id INTEGER NOT NULL,
      key TEXT NOT NULL,
      value TEXT,
      field_times TEXT,
      updated_at TEXT,
      PRIMARY KEY (user_id, key)
    )`);
    return db;
  };
  const db = open();
  return {
    db,
    path,
    open,
    close() { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); },
  };
}

const identity = (userId = '1') => ({ instanceUrl: 'https://nt.example.test', userId });
const claim = (source, userId = '1') => ({ connectionIdentity: identity(userId), source });

test('first claim fixes the source and a different source is refused', { skip }, () => {
  const s = scratch();
  try {
    const first = claimProvenance(s.db, 7, claim('withings'));
    assert.equal(first.ok, true);
    assert.equal(first.first, true);
    assert.equal(first.provenance.source, 'withings');

    const again = claimProvenance(s.db, 7, claim('withings'));
    assert.equal(again.ok, true, 'the same claim is idempotent');
    assert.equal(again.first, false);

    const other = claimProvenance(s.db, 7, claim('health_connect'));
    assert.equal(other.ok, false);
    assert.equal(other.code, 'source-provenance-conflict');
    assert.equal(other.provenance.source, 'withings', 'the refusal names the fixed source');
    assert.equal(readProvenance(s.db, 7).source, 'withings', 'the fixed claim is unchanged');
  } finally { s.close(); }
});

test('a different NutriTrace connection is refused even for the same source', { skip }, () => {
  const s = scratch();
  try {
    assert.equal(claimProvenance(s.db, 7, claim('withings', '1')).ok, true);
    const other = claimProvenance(s.db, 7, claim('withings', '2'));
    assert.equal(other.ok, false);
    assert.equal(other.code, 'connection-provenance-conflict');
    assert.equal(other.provenance.userId, '1');
  } finally { s.close(); }
});

test('two clients that both saw no marker: exactly one provenance wins', { skip }, () => {
  const s = scratch();
  const second = s.open();
  try {
    // Both tabs opened before the first import: both local markers are empty.
    assert.equal(readProvenance(s.db, 7), null);
    assert.equal(readProvenance(second, 7), null);

    const a = claimProvenance(s.db, 7, claim('source-a'));
    const b = claimProvenance(second, 7, claim('source-b'));

    assert.equal(a.ok, true);
    assert.equal(b.ok, false);
    assert.equal(b.code, 'source-provenance-conflict');
    assert.deepEqual(b.provenance, a.provenance, 'the loser learns the fixed provenance');
    assert.equal(readProvenance(second, 7).source, 'source-a');
  } finally {
    try { second.close(); } catch {}
    s.close();
  }
});

test('provenance is fixed per account, not shared between accounts', { skip }, () => {
  const s = scratch();
  try {
    assert.equal(claimProvenance(s.db, 7, claim('source-a')).ok, true);
    assert.equal(claimProvenance(s.db, 8, claim('source-b')).ok, true);
    assert.equal(readProvenance(s.db, 7).source, 'source-a');
    assert.equal(readProvenance(s.db, 8).source, 'source-b');
  } finally { s.close(); }
});

test('the legacy two-setting marker is adopted, not re-opened', { skip }, () => {
  const s = scratch();
  try {
    const insert = s.db.prepare('INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?)');
    insert.run(7, 'ntBodySyncedSource', JSON.stringify('withings'));
    insert.run(7, 'ntBodySyncedConnectionIdentity', JSON.stringify(identity('1')));

    const switched = claimProvenance(s.db, 7, claim('health_connect'));
    assert.equal(switched.ok, false);
    assert.equal(switched.code, 'source-provenance-conflict');

    const adopted = claimProvenance(s.db, 7, claim('withings'));
    assert.equal(adopted.ok, true);
    assert.equal(adopted.first, true);
    const row = s.db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?')
      .get(7, NT_BODY_PROVENANCE_KEY);
    assert.ok(row, 'the adopted marker becomes the atomically written claim');
    assert.equal(JSON.parse(row.value).source, 'withings');
  } finally { s.close(); }
});

test('a legacy source without its connection identity cannot be adopted', { skip }, () => {
  const s = scratch();
  try {
    s.db.prepare("INSERT INTO user_settings (user_id, key, value) VALUES (?, 'ntBodySyncedSource', ?)")
      .run(7, JSON.stringify('withings'));
    const result = claimProvenance(s.db, 7, claim('withings'));
    assert.equal(result.ok, false);
    assert.equal(result.code, 'connection-provenance-conflict');
    assert.equal(readProvenance(s.db, 7), null);
  } finally { s.close(); }
});

test('an imported body write is refused unless it carries the fixed provenance', { skip }, () => {
  const s = scratch();
  try {
    const fixed = claimProvenance(s.db, 7, claim('source-a')).provenance;
    assert.equal(verifyProvenance(s.db, 7, fixed).ok, true);

    const otherSource = verifyProvenance(s.db, 7, { ...fixed, source: 'source-b' });
    assert.equal(otherSource.ok, false);
    assert.equal(otherSource.code, 'provenance-mismatch');

    const otherConnection = verifyProvenance(s.db, 7, { ...fixed, userId: '2' });
    assert.equal(otherConnection.ok, false);
    assert.equal(otherConnection.code, 'provenance-mismatch');

    assert.equal(verifyProvenance(s.db, 7, null).code, 'invalid-provenance');
    assert.equal(verifyProvenance(s.db, 9, fixed).code, 'provenance-missing');
  } finally { s.close(); }
});

test('two processes starting at once: exactly one provenance is fixed', { skip }, async () => {
  const { spawn } = await import('node:child_process');
  const s = scratch();
  const lib = new URL('../server/lib/nt-body-provenance.js', import.meta.url).href;
  const serverJson = new URL('../server/package.json', import.meta.url).href;
  // A child process of its own is the honest "second client": it opens the
  // same database file and claims a different source without sharing any
  // in-process state with the first.
  const script = `
    import { createRequire } from 'node:module';
    const require = createRequire(${JSON.stringify(serverJson)});
    let Database = null;
    try { const D = require('better-sqlite3'); new D(':memory:').close(); Database = D; } catch {}
    if (!Database) { ({ DatabaseSync: Database } = await import('node:sqlite')); }
    const { claimProvenance } = await import(${JSON.stringify(lib)});
    const db = new Database(process.env.RACE_DB);
    db.exec('PRAGMA busy_timeout = 5000');
    const result = claimProvenance(db, 7, {
      connectionIdentity: { instanceUrl: 'https://nt.example.test', userId: '1' },
      source: process.env.RACE_SOURCE,
    });
    db.close();
    process.stdout.write(JSON.stringify(result));
  `;
  const claimInChild = (source) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, RACE_DB: s.path, RACE_SOURCE: source },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      try { resolve(JSON.parse(out)); } catch { reject(new Error(`child ${code} said ${err || out}`)); }
    });
  });

  try {
    const results = await Promise.all([claimInChild('source-a'), claimInChild('source-b')]);
    const winners = results.filter(result => result?.ok === true);
    const losers = results.filter(result => result?.ok === false);
    assert.equal(winners.length, 1, 'exactly one claim wins across processes');
    assert.equal(losers.length, 1, 'the other client is refused');
    assert.equal(losers[0].code, 'source-provenance-conflict');
    assert.equal(readProvenance(s.db, 7).source, winners[0].provenance.source);
  } finally { s.close(); }
});

// ── The claim must describe the read it came from ──────────────────────────
// A read is answered by whichever connection is saved at that moment; the saved
// connection can be switched away and back before the claim. The receipt ties
// the two together.

test('a read receipt is single-use, per account, and expires', async () => {
  const { issueReadReceipt, takeReadReceipt, resetReadReceipts } = await import(
    '../server/lib/nt-read-receipts.js'
  );
  resetReadReceipts();
  const identityA = {
    instanceUrl: 'https://a.example.test', userId: '1',
    fingerprint: 'fp-a', version: 4,
  };
  const now = 1_000_000;

  const readId = issueReadReceipt(11, identityA, now);
  assert.ok(readId);
  assert.deepEqual(takeReadReceipt(readId, 11, now + 1000), identityA);
  assert.equal(takeReadReceipt(readId, 11, now + 1000), null, 'a second claim cannot reuse the read');

  const second = issueReadReceipt(11, identityA, now);
  assert.equal(takeReadReceipt(second, 12, now), null, 'another account cannot use the read');

  const third = issueReadReceipt(11, identityA, now);
  assert.equal(takeReadReceipt(third, 11, now + 11 * 60 * 1000), null, 'an expired read cannot be used');

  assert.equal(takeReadReceipt('', 11, now), null);
  assert.equal(takeReadReceipt('not-a-receipt', 11, now), null);
  assert.equal(issueReadReceipt(null, identityA, now), null);
  resetReadReceipts();
});

test('tab 1 read under A, tab 2 switched to B, tab 2 switched back: A cannot claim B\'s read', async () => {
  const { issueReadReceipt, takeReadReceipt, resetReadReceipts } = await import(
    '../server/lib/nt-read-receipts.js'
  );
  const { readMatchesClaim } = await import('../server/lib/nt-body-provenance.js');
  resetReadReceipts();
  const identityA = { instanceUrl: 'https://a.example.test', userId: '1' };
  const identityB = { instanceUrl: 'https://b.example.test', userId: '7' };
  const now = 5_000_000;

  // Both tabs start with A saved; tab 1 reads.
  const readUnderA = issueReadReceipt(11, identityA, now);
  assert.equal(readMatchesClaim(takeReadReceipt(readUnderA, 11, now + 1), { ...identityA, source: 'source-a' }), true);

  // Tab 2 switches the saved connection to B before tab 1's next read, so the
  // proxy answers that read with B.
  const readUnderB = issueReadReceipt(11, identityB, now + 2);
  // Tab 2 switches back to A; tab 1 now claims A with the receipt of its read.
  const receipt = takeReadReceipt(readUnderB, 11, now + 3);
  assert.equal(readMatchesClaim(receipt, { ...identityA, source: 'source-a' }), false,
    'measurements read through B cannot be attributed to A');
  resetReadReceipts();
});

// ── Reserved settings and deletion semantics ───────────────────────────────

test('reserved provenance keys cannot be written through the settings API', async () => {
  const { isReservedProvenanceKey } = await import('../server/lib/nt-body-provenance.js');
  for (const key of ['ntBodyProvenance', 'ntBodySyncedSource', 'ntBodySyncedConnectionIdentity']) {
    assert.equal(isReservedProvenanceKey(key), true, `${key} is server-owned`);
  }
  for (const key of ['ntInstanceUrl', 'ntInstanceToken', 'ntConnectionIdentity', 'ntBodySource', 'weightUnit']) {
    assert.equal(isReservedProvenanceKey(key), false);
  }
});

test('deleting settings keeps the claim; clearing data releases it with the history', { skip }, async () => {
  const {
    deleteUserSettingsKeepingProvenance,
    clearProvenance,
  } = await import('../server/lib/nt-body-provenance.js');
  const s = scratch();
  try {
    const insert = s.db.prepare('INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?)');
    insert.run(7, 'ntInstanceUrl', JSON.stringify('https://nt.example.test'));
    insert.run(7, 'ntBodySyncedSource', JSON.stringify('source-a'));
    insert.run(7, 'ntBodySyncedConnectionIdentity', JSON.stringify(identity('1')));
    assert.equal(claimProvenance(s.db, 7, claim('source-a')).ok, true);

    deleteUserSettingsKeepingProvenance(s.db, 7);
    assert.equal(readProvenance(s.db, 7).source, 'source-a', 'the claim survives a settings wipe');
    assert.equal(
      s.db.prepare("SELECT 1 FROM user_settings WHERE user_id = 7 AND key = 'ntInstanceUrl'").get(),
      undefined,
      'ordinary settings are deleted',
    );
    assert.equal(claimProvenance(s.db, 7, claim('source-b')).code, 'source-provenance-conflict',
      'and the claim still owns the history');

    clearProvenance(s.db, 7);
    assert.equal(readProvenance(s.db, 7), null, 'clear-data releases the claim with the imported history');
    assert.equal(claimProvenance(s.db, 7, claim('source-b')).ok, true);
  } finally { s.close(); }
});

test('a source is stored exactly as chosen, spaces included', { skip }, () => {
  const s = scratch();
  try {
    const spaced = ' source-a ';
    const accepted = claimProvenance(s.db, 7, { connectionIdentity: identity('1'), source: spaced });
    assert.equal(accepted.ok, true);
    assert.equal(accepted.provenance.source, spaced, 'the echo carries the same exact source');
    assert.equal(readProvenance(s.db, 7).source, spaced);

    const sameAgain = claimProvenance(s.db, 7, { connectionIdentity: identity('1'), source: spaced });
    assert.equal(sameAgain.ok, true, 'the client can claim its own exact source again');
    assert.equal(claimProvenance(s.db, 7, {
      connectionIdentity: identity('1'), source: 'source-a',
    }).code, 'source-provenance-conflict', 'a different exact source is a different source');
  } finally { s.close(); }
});

test('a source that cannot name a measurement source is rejected, not silently rewritten', { skip }, () => {
  const s = scratch();
  try {
    for (const source of ['', 'x'.repeat(201), 7, null, undefined]) {
      const result = claimProvenance(s.db, 7, { connectionIdentity: identity('1'), source });
      assert.equal(result.ok, false);
      assert.equal(result.code, 'invalid-claim');
    }
    assert.equal(readProvenance(s.db, 7), null, 'a rejected claim fixes nothing');
  } finally { s.close(); }
});
