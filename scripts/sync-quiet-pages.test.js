/**
 * A sync that brought nothing leaves the pages' local reads alone (each
 * would start another sync), but what only the server has still refreshes,
 * and a write queued behind a create is sent at once however recently a
 * sync ran.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');

test('a write queued behind a create starts its sync at once', () => {
  const f = read('../src/lib/apiFetch.js');
  assert.match(f, /_kickBackgroundSync\(\{ force: true \}\)/);
  assert.match(f, /if \(!force && now - \(lastSyncDoneAt\?\.\(\) \|\| 0\) < 30000\) return;/);
});

test("the Diary still asks the server for the coach's feedback and suggestions after a quiet sync", () => {
  const d = read('../src/routes/Diary.svelte');
  const quiet = d.slice(d.indexOf('if (e?.detail?.changed === false) {'), d.indexOf('const t = e?.detail?.tables;'));
  for (const call of ['loadCoachFeedback(', 'loadUnreadFeedback()', 'loadSuggestedPrescriptions()']) assert.ok(quiet.includes(call), call);
  assert.ok(!quiet.includes('loadWorkoutDates()'), 'no local reads');
});

test('Statistics refreshes now and then after quiet syncs, for cardio from the web or the watch', () => {
  assert.match(read('../src/routes/Statistics.svelte'), /Date\.now\(\) - _quietAt < 5 \* 60 \* 1000/);
});

test('a pull that only removed rows is a change', () => {
  assert.match(read('../src/lib/sync.js'), /result\.changed = Object\.values\(result\.tables\)\.some\(n => Number\(n\) > 0\);/);
});
