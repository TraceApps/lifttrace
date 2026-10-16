/**
 * A migration must not name a table the schema has not created yet.
 *
 * The set-video work added two `addColumnIfMissing('coach_feedback', ...)`
 * calls above that table's CREATE. An upgrade was fine, because the table was
 * already there from an earlier release, but a brand new install died at
 * startup with "no such table: coach_feedback" and the server never came up.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const db = readFileSync(new URL('../server/db.js', import.meta.url), 'utf8');

test('every migration runs after its table is created', () => {
  const createdAt = new Map();
  for (const m of db.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)) {
    if (!createdAt.has(m[1])) createdAt.set(m[1], m.index);
  }
  const early = [];
  for (const m of db.matchAll(/addColumnIfMissing\('(\w+)'/g)) {
    const created = createdAt.get(m[1]);
    if (created === undefined) { early.push(`${m[1]} (never created here)`); continue; }
    if (m.index < created) early.push(`${m[1]} at ${m.index}, created at ${created}`);
  }
  assert.deepEqual(early, []);
});

test('and a migration for a table that is not there yet is a no-op, not a crash', () => {
  const at = db.indexOf('function addColumnIfMissing');
  const fn = db.slice(at, db.indexOf('\n}', at));
  assert.match(fn, /if \(cols\.length === 0\) return;/);
});
