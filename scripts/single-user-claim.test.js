/**
 * Guards the single-user -> multi-user data handover (docs issue #2).
 *
 * In single-user mode there is no users row, so `uid()` writes NULL and the
 * ownership filters are skipped entirely. Enabling user management creates
 * the first account, and routes/auth.js must re-point ALL of that data at
 * it. Miss a table and the data silently stops being visible.
 *
 * The expected set is derived from db.js rather than frozen here, so adding
 * a user-scoped table without claiming it fails this test.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const dbJs   = readFileSync(new URL('../server/db.js', import.meta.url), 'utf8');
const authJs = readFileSync(new URL('../server/routes/auth.js', import.meta.url), 'utf8');
const oidcJs = readFileSync(new URL('../server/routes/oidc.js', import.meta.url), 'utf8');
const claimJs = readFileSync(new URL('../server/lib/claim-anonymous-data.js', import.meta.url), 'utf8');
const indexJs = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');

function nullableUserIdTables(src) {
  const out = [];
  const re = /CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]*?)\n\s*\);/g;
  let m;
  while ((m = re.exec(src))) {
    const [, name, body] = m;
    const col = body.split('\n').find(l => /^\s*user_id\b/.test(l));
    if (col && !/NOT NULL/.test(col)) out.push(name);
  }
  return out;
}
function claimList(name) {
  const m = claimJs.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\]`));
  assert.ok(m, `${name} not found in lib/claim-anonymous-data.js`);
  return [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
}

const EXCLUDED = {
  oauth_state: 'short-lived OIDC CSRF state, not user data',
};

test('every table that can hold anonymous rows is claimed on first registration', () => {
  const claimed = new Set(claimList('CLAIM_NULL'));
  const missing = nullableUserIdTables(dbJs).filter(t => !claimed.has(t) && !EXCLUDED[t]);
  assert.deepEqual(missing, [],
    `these tables can hold single-user-mode rows but are never claimed: ${missing.join(', ')}`);
});

test('created_by ownership columns are claimed too', () => {
  // programs and exercises key ownership on created_by, not user_id, so the
  // nullable-user_id sweep above cannot see them.
  assert.match(claimJs, /UPDATE programs SET created_by = \? WHERE created_by IS NULL/);
  assert.match(claimJs, /UPDATE exercises SET created_by = \?/);
});

test('the global exercise catalog is NOT claimed', () => {
  // exercises are filtered as `is_global = 1 OR created_by = ?`. Global rows
  // legitimately have created_by NULL and are shared by every user; claiming
  // them would hand the shared catalog to whoever registers first.
  assert.match(claimJs, /UPDATE exercises SET created_by = \? WHERE created_by IS NULL AND is_global = 0/);
});

test('the claim runs in a single transaction', () => {
  assert.match(claimJs, /export const claimAnonymousData = db\.transaction\(/);
});

test('the claim only fires for the first account', () => {
  assert.match(authJs, /if \(isFirst\) \{\s*\n\s*claimAnonymousData\(user\.id\);/);
});

test('BOTH first-account paths claim: password registration and OIDC bootstrap', () => {
  // There are two ways to become the first account. routes/oidc.js used to
  // carry its own shorter copy of the claim list, so an OIDC-first instance
  // silently kept the original bug after the password path was fixed.
  for (const [name, src] of [['routes/auth.js', authJs], ['routes/oidc.js', oidcJs]]) {
    assert.match(src, /import \{[^}]*\bclaimAnonymousData\b[^}]*\} from '\.\.\/lib\/claim-anonymous-data\.js'/,
      `${name} must import the shared claim helper`);
  }
  assert.match(oidcJs, /claimAnonymousData\(result\.user\.id\)/);
  // and neither route may hand-roll its own UPDATE ... user_id IS NULL again
  for (const [name, src] of [['routes/auth.js', authJs], ['routes/oidc.js', oidcJs]]) {
    assert.doesNotMatch(src, /UPDATE \w+\s+SET user_id = \? WHERE user_id IS NULL/,
      `${name} should call claimAnonymousData(), not re-implement the claim`);
  }
});

test('claiming clears the single_user_mode flag', () => {
  // /status reports single_user_mode straight from app_config; leaving it set
  // after an account exists makes the instance describe itself wrongly.
  assert.match(claimJs, /DELETE FROM app_config WHERE key = 'single_user_mode'/);
});

test('startup runs the one-time repair for instances that upgraded past the bug', () => {
  // The claim only fires while the first account is created, so an instance
  // that already enabled user management on an older build needs adopting.
  assert.match(indexJs, /repairOrphanedData/);
  assert.match(claimJs, /export function repairOrphanedData/);
});

test('the repair refuses to guess when ownership is ambiguous', () => {
  // Zero accounts is ordinary single-user mode and must be left alone; two or
  // more means the rows cannot be attributed without asking a human.
  const body = claimJs.match(/export function repairOrphanedData\(\) \{([\s\S]*?)\n\}/)[1];
  assert.match(body, /users\.length === 0/);
  assert.match(body, /users\.length > 1/);
  assert.match(body, /ambiguous/);
});

test('disabling user management hands data back instead of stranding it', () => {
  // None of LiftTrace's data tables carry an FK to users(id), so DELETE FROM
  // users leaves rows behind at a user id that single-user mode cannot read,
  // and AUTOINCREMENT means a re-enable never matches it again.
  assert.match(claimJs, /export const anonymizeUserData = db\.transaction\(/);
  assert.match(claimJs, /export function releaseDataBeforeDisable/);
  const disable = authJs.match(/router\.delete\('\/management'[\s\S]*?\}\)\);/)[0];
  assert.match(disable, /releaseDataBeforeDisable\(\)/);
  assert.ok(disable.indexOf('releaseDataBeforeDisable') < disable.indexOf('DELETE FROM users'),
    'must anonymise BEFORE the accounts are dropped');
});

test('the lockout-recovery path hands data back too', () => {
  const recover = authJs.match(/router\.post\('\/recover'[\s\S]*?\n\}\)\);/)[0];
  assert.match(recover, /releaseDataBeforeDisable\(\)/);
});

test('anonymise is the exact inverse of the claim', () => {
  // Any table added to one must be added to the other, or the round trip
  // silently stops being lossless.
  const anon = claimJs.match(/export const anonymizeUserData = db\.transaction\(([\s\S]*?)\n\}\);/)[1];
  assert.match(anon, /for \(const t of CLAIM_NULL\)/);
  assert.match(anon, /UPDATE programs SET created_by = NULL/);
  assert.match(anon, /UPDATE exercises SET created_by = NULL WHERE created_by = \? AND is_global = 0/);
});

test('every account-removal path clears rows the FK cascade cannot reach', () => {
  // Self-delete, admin delete, disable and lockout-recovery all remove
  // accounts. Tables with no FK to users(id) survive that, so each path has to
  // clean up explicitly or a deleted user's rows (wearable history, live OAuth
  // refresh tokens) stay in the database.
  for (const h of ["router.delete('/me'", "router.delete('/users/:id'"]) {
    const i = authJs.indexOf(h);
    assert.ok(i > -1, `${h} handler not found`);
    const body = authJs.slice(i, i + 2000);
    assert.match(body, /purgeUserRows\(/, `${h} must purge non-cascading tables`);
  }
});

test('disabling with several accounts purges rather than stranding', () => {
  // Anonymising only works with one account; several would collide on
  // UNIQUE(user_id, date). Leaving them would strand the rows at an id
  // single-user mode can never read.
  const body = claimJs.match(/export function releaseDataBeforeDisable\(\) \{([\s\S]*?)\n\}/)[1];
  assert.match(body, /users\.length === 1/);
  assert.match(body, /purgeAllUserData/);
  assert.match(claimJs, /DELETE FROM exercises WHERE created_by = \? AND is_global = 0/,
    'the purge must not touch the shared global catalog');
});

test('no user-scoped table without an FK is left out of the cleanup', () => {
  // Tables that carry an FK to users(id) are cleaned by ON DELETE CASCADE.
  // Every other user-scoped table has to be removed explicitly or a deleted
  // account's rows survive. Derived from db.js, so a new table cannot slip in.
  const noFk = [];
  const re = /CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]*?)\n\s*\);/g;
  let m;
  while ((m = re.exec(dbJs))) {
    const [, name, body] = m;
    const col = body.split('\n').find(l => /^\s*user_id\b/.test(l));
    if (col && !/REFERENCES users/.test(col)) noFk.push(name);
  }
  const listed = new Set([...(claimJs.match(/NO_CASCADE_TABLES = \[([\s\S]*?)\]/)?.[1] || '')
    .matchAll(/'(\w+)'/g)].map(x => x[1]));
  const explicit = new Set([...`${authJs}${claimJs}`.matchAll(/DELETE FROM (\w+) WHERE user_id = \?/g)].map(x => x[1]));
  const missing = noFk.filter(t => !listed.has(t) && !explicit.has(t));
  assert.deepEqual(missing, [],
    `no FK and never explicitly deleted, so a removed account's rows survive: ${missing.join(', ')}`);
});
