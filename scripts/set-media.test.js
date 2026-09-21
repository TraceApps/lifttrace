/**
 * Set videos (issue #57).
 *
 * The rules worth pinning are the ones that would quietly stop holding: who
 * can read a clip, where a row is allowed to point, and the lifecycle
 * touchpoints a table owning files on disk has to clear. The behaviour was
 * verified end to end against a running server (upload, attach, read as the
 * owner and as their trainer, refuse for everyone else, note at a timestamp,
 * delete, cleanup); these keep the wiring from drifting.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const lib = read('../server/lib/set-media.js');
const route = read('../server/routes/set-media.js');
const upload = read('../server/routes/upload.js');
const db = read('../server/db.js');

test('clips are never served from the static uploads tree', () => {
  // That tree is mounted ahead of requireAuth so images load without a
  // header, which makes anything in it readable by URL.
  const paths = read('../server/lib/upload-paths.js');
  assert.match(paths, /const PRIVATE_SUBDIRS = \[[^\]]*'set-videos'/);
  assert.match(route, /router\.get\('\/:id\/file'/, 'read through a route that checks the owner');
});

test('a row may only point inside the clip directory', () => {
  // Otherwise the file route becomes a confused deputy: point a row you own
  // at a backup archive, then read your own row's bytes.
  assert.match(lib, /export const VIDEO_DIR = '\/uploads\/set-videos\/';/);
  assert.match(lib, /export function isLocalVideoUrl/);
  assert.match(route, /if \(!isLocalVideoUrl\(url\)\)/);
});

test('a clip is readable by its owner and that owner\'s trainer, and nobody else', () => {
  const fn = lib.slice(lib.indexOf('export function canReadMedia'), lib.indexOf('export function resolveVideoFileForViewer'));
  assert.match(fn, /row\.user_id === viewerId/, 'the owner');
  assert.match(fn, /SELECT trainer_id FROM users WHERE id = \?/, 'checked against the database');
  assert.match(fn, /owner\.trainer_id === viewerId/);
  assert.doesNotMatch(fn, /role\s*===\s*'admin'/, 'admins get no special case, same as progress photos');
});

test('a coach note can only point at a clip on the workout being commented on', () => {
  const trainer = read('../server/routes/trainer.js');
  assert.match(trainer, /SELECT id FROM set_media WHERE id = \? AND workout_id = \? AND user_id = \? AND deleted_at IS NULL/);
  assert.match(trainer, /That clip is not on this workout/);
});

test('uploads are capped and checked by their bytes, not their name', () => {
  const block = upload.slice(upload.indexOf('const setVideoUpload'), upload.indexOf("router.post('/body-stats'"));
  assert.match(block, /fileSize: 200 \* 1024 \* 1024/);
  assert.match(block, /assertAllowedMedia\(req\.file\.path, \['video'\]\)/);
  assert.match(block, /LIMIT_FILE_SIZE/, 'the size error says what the limit is');
});

test('deleting a clip removes the file and keeps the coach note', () => {
  const del = route.slice(route.indexOf("router.delete('/:id'"), route.indexOf("router.post('/cleanup'"));
  assert.match(del, /UPDATE set_media SET deleted_at = datetime\('now'\)/, 'soft-delete so the removal syncs');
  assert.match(del, /unlinkMediaFile\(row\.url\)/, 'and the file goes, rather than lingering as an orphan');
  assert.match(del, /UPDATE coach_feedback SET media_id = NULL, media_time_sec = NULL/);
});

test('the table clears the same lifecycle touchpoints progress photos do', () => {
  assert.match(db, /CREATE TABLE IF NOT EXISTS set_media/);
  assert.match(db, /\{ table: 'set_media',\s+hasCreated: 'created_at',\s+byUser: 'user_id' \}/, 'syncs');
  assert.match(read('../server/lib/claim-anonymous-data.js'), /'set_media'/, 'claimed on first sign-up');

  const backup = read('../server/routes/full-backup.js');
  assert.match(backup, /set_media:\s+safe\('SELECT \* FROM set_media'\)/, 'exported');
  assert.match(backup, /DELETE FROM set_media/, 'wiped before a restore');
  assert.match(backup, /INSERT OR IGNORE INTO set_media/, 'and written back, or the files would be orphans');
});

test('clip rows can never be cascaded away behind the file-aware delete', () => {
  // With ON DELETE CASCADE on workout_id, deleting a user's workouts (which
  // account deletion does) removed the rows first, so the helper that unlinks
  // the files found nothing and left them on disk. Caught in testing; the
  // table carries no FK for exactly this reason.
  const table = db.slice(db.indexOf('CREATE TABLE IF NOT EXISTS set_media'), db.indexOf('idx_set_media_user_date'));
  assert.doesNotMatch(table, /REFERENCES/, 'no FK, so nothing removes a clip row without going through the helper');
  const auth = read('../server/routes/auth.js');
  for (const block of auth.split('router.').slice(1).filter(b => b.includes('deleteSetMediaForUser'))) {
    assert.ok(
      block.indexOf('deleteSetMediaForUser') < block.indexOf("DELETE FROM workout_log"),
      'the files go before anything that could remove their rows',
    );
  }
});

test('every path that deletes a user deletes their clips and files', () => {
  for (const f of ['../server/routes/auth.js', '../server/routes/settings.js', '../server/lib/claim-anonymous-data.js']) {
    const src = read(f);
    assert.match(src, /deleteMediaForUser as deleteSetMediaForUser/, `${f} imports it`);
    assert.match(src, /deleteSetMediaForUser\(/, `${f} calls it`);
  }
  assert.match(lib, /for \(const r of rows\) unlinkMediaFile\(r\.url\)/);
});

test('clips travel between devices, but only as rows', () => {
  const sync = read('../server/routes/sync.js');
  assert.match(sync, /SELECT \* FROM set_media WHERE updated_at >= \?/, 'pulled');
  assert.match(sync, /for \(const m of \(body\.set_media \|\| \[\]\)\)/, 'pushed');
  assert.match(sync, /if \(!m\.server_id\) continue;/, 'never inserts: a row needs a file that already exists');
});

test('the retention story is manual, and says so', () => {
  assert.match(lib, /export function mediaUsageForUser/, 'what the clips cost is visible');
  assert.match(lib, /export function deleteMediaOlderThan/, 'and clearing them out is one action');
  assert.doesNotMatch(lib, /setInterval|scheduler|cron/, 'nothing expires on its own');
  const settings = read('../src/components/settings/SettingsWorkout.svelte');
  assert.match(settings, /getSetMediaUsage/);
  assert.match(settings, /cleanupSetMedia/);
});

test('the UI keeps the member and the coach to their own half', () => {
  const player = read('../src/components/diary/SetVideoPlayer.svelte');
  assert.match(player, /\{#if note && !coach\}/, 'only the member gets the reply box');
  assert.match(player, /\{:else if note\?\.member_reply && coach\}/, 'the coach sees the reply, not a reply box');
  assert.match(player, /media_time_sec: noteAt/, 'the coach note carries the moment it is about');
  assert.match(player, /videoEl\.currentTime = Math\.max\(0, seconds\)/, 'and tapping a timestamp seeks there');
});

test('attaching a clip needs a connection, and says so rather than failing quietly', () => {
  const sheet = read('../src/components/diary/SetVideoSheet.svelte');
  assert.match(sheet, /\{#if !online\}/);
  assert.match(sheet, /set_video\.needs_connection/);
  const en = JSON.parse(read('../src/i18n/en.json'));
  assert.match(en.set_video.needs_connection, /connection/i);
  assert.ok(en.set_video.too_large.includes('200 MB'));
});

test('filming in the app is what keeps a clip small', () => {
  const sheet = read('../src/components/diary/SetVideoSheet.svelte');
  assert.match(sheet, /videoBitsPerSecond: RECORD_BITRATE/);
  assert.match(sheet, /const MAX_SECONDS = 60/);
});
