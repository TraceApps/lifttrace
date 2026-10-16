/**
 * src/lib/updates.js is the same file in every Trace app except its app
 * constants; CSRF_KEY is one of them. LiftTrace's copy read NutriTrace's
 * key ('nt:csrf'). This server has no CSRF check, so nothing failed, but a
 * copy kept in step can't carry another app's key into one that does.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('updates.js reads LiftTrace\'s own CSRF key, through its constant', () => {
  const updates = read('../src/lib/updates.js');
  assert.match(updates, /const CSRF_KEY = 'lt:csrf';/);
  assert.match(updates, /localStorage\.getItem\(CSRF_KEY\)/);
});

test('nothing in LiftTrace reads another app\'s CSRF key', () => {
  for (const f of ['../src/lib/updates.js', '../src/components/settings/SettingsAuth.svelte', '../src/components/settings/SettingsFederation.svelte']) {
    assert.doesNotMatch(read(f), /getItem\('(nt|ct|note):csrf'\)/, f);
  }
});
