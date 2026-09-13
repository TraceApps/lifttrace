/**
 * Static-analysis tests for the progress-photos feature.
 *
 * No DB import, so these run without a compiled better-sqlite3 binding.
 * They guard the wiring that is easy to half-finish: a new per-user table
 * has to clear five separate lifecycle touchpoints in this app, and the
 * webhook has to fire from the shared core function rather than one
 * route, which is the exact bug that shipped in the NutriTrace and
 * CookTrace webhook ports before review caught it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

const dbJs        = read('../server/db.js');
const claimJs     = read('../server/lib/claim-anonymous-data.js');
const backupJs    = read('../server/routes/full-backup.js');
const syncJs      = read('../server/routes/sync.js');
const uploadJs    = read('../server/routes/upload.js');
const bodyStatsJs = read('../server/routes/body-stats.js');
const publicApiJs = read('../server/routes/public-api.js');
const toolsIndex  = read('../server/lib/mcp/tools/index.js');
const addToolJs   = read('../server/lib/mcp/tools/add-progress-photo.js');
const listToolJs  = read('../server/lib/mcp/tools/list-progress-photos.js');
const webhooksJs  = read('../server/lib/webhooks.js');
const mediaLibJs  = read('../server/lib/body-stat-media.js');
const uploadPathsJs = read('../server/lib/upload-paths.js');
const appSvelte   = read('../src/App.svelte');
const bottomNav   = read('../src/components/layout/BottomNav.svelte');

test('body_stat_media table exists, with a kind column and no UNIQUE on (user_id, date)', () => {
  const m = dbJs.match(/CREATE TABLE IF NOT EXISTS body_stat_media \(([\s\S]*?)\n\s*\);/);
  assert.ok(m, 'expected the body_stat_media CREATE TABLE in db.js');
  const body = m[1];
  assert.match(body, /kind\s+TEXT NOT NULL DEFAULT 'photo'/);
  assert.match(body, /url\s+TEXT NOT NULL/);
  // Several photos per date is the whole point (front and side shots),
  // so a UNIQUE key on (user_id, date) would be a real bug here.
  assert.doesNotMatch(body, /UNIQUE\s*\(\s*user_id\s*,\s*date\s*\)/);
});

test('the table is registered for sync (SYNCABLE) so updated_at/deleted_at exist', () => {
  assert.match(dbJs, /\{ table: 'body_stat_media',\s*hasCreated: 'created_at',\s*byUser: 'user_id' \}/);
});

test('anonymous single-user rows get claimed by the first account (CLAIM_NULL)', () => {
  const listed = claimJs.match(/CLAIM_NULL = \[([\s\S]*?)\]/)[1];
  assert.match(listed, /'body_stat_media'/);
});

test('account deletion removes the files, not just the rows', () => {
  // A plain row DELETE would strand the JPEGs, which is the orphan-upload
  // debt ROADMAP.md already tracks for exercise media. Do not repeat it.
  assert.match(mediaLibJs, /export function deleteMediaForUser/);
  assert.match(mediaLibJs, /unlinkMediaFile/);
  const authJs = read('../server/routes/auth.js');
  const settingsJs = read('../server/routes/settings.js');
  assert.equal((authJs.match(/deleteMediaForUser\(/g) || []).length, 2,
    'both account-deletion paths in auth.js must call the file-aware helper');
  assert.match(settingsJs, /deleteMediaForUser\(/);
  assert.match(claimJs, /deleteMediaForUser\(/);
});

test('unlink refuses a path that escapes the uploads directory', () => {
  // Lives in upload-paths.js, which has no db.js import, specifically so
  // scripts/body-stat-media.test.js can execute this guard for real
  // rather than skipping it for want of a native binding.
  assert.match(uploadPathsJs, /startsWith\(root \+ path\.sep\)/);
  assert.doesNotMatch(uploadPathsJs, /from '\.\.\/db\.js'/);
});

test('full backup exports the rows AND restores every column, including the sync ones', () => {
  assert.match(backupJs, /body_stat_media:\s*safe\('SELECT \* FROM body_stat_media'\)/);
  assert.match(backupJs, /DELETE FROM body_stat_media/);
  const ins = backupJs.match(/INSERT OR IGNORE INTO body_stat_media \(([^)]*)\)/);
  assert.ok(ins, 'expected a restore insert for body_stat_media');
  for (const col of ['id', 'user_id', 'date', 'kind', 'url', 'created_at', 'updated_at', 'deleted_at']) {
    assert.match(ins[1], new RegExp(`\\b${col}\\b`), `restore must carry ${col} through`);
  }
});

test('sync pulls and pushes the table, keyed by server_id rather than date', () => {
  assert.match(syncJs, /SELECT \* FROM body_stat_media WHERE updated_at >= \?/);
  assert.match(syncJs, /body_stat_media,/);              // included in the pull response
  assert.match(syncJs, /body_stat_media: \[\]/);          // present in the push result shape
  // A date can hold several photos, so identity is the row id, not the
  // (user_id, date) pair body_stats_log matches on.
  assert.match(syncJs, /SELECT \* FROM body_stat_media WHERE id = \?/);
});

test('upload route is image-only, 20 MB, magic-byte validated, in its own subdirectory', () => {
  assert.match(uploadJs, /router\.post\('\/body-stats'/);
  assert.match(uploadJs, /fileSize: 20 \* 1024 \* 1024/);
  assert.match(uploadJs, /assertAllowedMedia\(req\.file\.path, \['image'\]\)/);
  assert.match(uploadJs, /path\.join\(uploadsPath, 'body-stats'\)/);
});

test('app routes are declared before /:date so "photos" is not read as a date', () => {
  const photosIdx = bodyStatsJs.indexOf("router.get('/photos'");
  const dateIdx = bodyStatsJs.indexOf("router.get('/:date'");
  assert.ok(photosIdx > -1 && dateIdx > -1);
  assert.ok(photosIdx < dateIdx, '/photos must be registered before /:date');

  const apiPhotosIdx = publicApiJs.indexOf("router.get('/body-stats/photos'");
  const apiDateIdx = publicApiJs.indexOf("router.get('/body-stats/:date'");
  assert.ok(apiPhotosIdx > -1 && apiDateIdx > -1);
  assert.ok(apiPhotosIdx < apiDateIdx, '/body-stats/photos must precede /body-stats/:date');
});

test('one implementation: the app routes and REST routes call the same xCore functions', () => {
  for (const src of [bodyStatsJs, publicApiJs]) {
    assert.match(src, /listProgressPhotosCore\(/);
    assert.match(src, /addProgressPhotoCore\(/);
  }
  // Neither route file should be running its own INSERT for photos.
  assert.doesNotMatch(publicApiJs, /INSERT INTO body_stat_media/);
  assert.doesNotMatch(bodyStatsJs, /INSERT INTO body_stat_media/);
});

test('MCP tools are registered in the right tiers', () => {
  assert.match(toolsIndex, /registerListProgressPhotos\(server, ctx\)/);
  assert.match(toolsIndex, /registerAddProgressPhoto\(server, ctx\)/);
  const readBody = toolsIndex.match(/export function registerReadTools[\s\S]*?\n\}/)[0];
  const writeBody = toolsIndex.match(/export function registerWriteTools[\s\S]*?\n\}/)[0];
  assert.match(readBody, /registerListProgressPhotos/);
  assert.match(writeBody, /registerAddProgressPhoto/);
});

test('REST routes reuse the mcp scopes and gate writes behind the write flag', () => {
  assert.match(publicApiJs, /router\.get\('\/body-stats\/photos', requireScope\('mcp:read'\)/);
  assert.match(publicApiJs, /router\.post\('\/body-stats\/photos', requireWriteEnabled, requireScope\('mcp:write'\)/);
});

test('no DELETE on the public API, matching its existing no-destroy posture', () => {
  assert.doesNotMatch(publicApiJs, /router\.delete\(/);
});

test('progress_photo.logged fires from the shared core function, not a route', () => {
  assert.match(webhooksJs, /'progress_photo\.logged'/);
  // The whole point: MCP and REST writes must fire it too, so the call
  // belongs in addProgressPhotoCore, not in whichever route happens to
  // be the UI's entry point.
  assert.match(addToolJs, /dispatchWebhookEvent\(userId, 'progress_photo\.logged'/);
  assert.doesNotMatch(bodyStatsJs, /'progress_photo\.logged'/);
  assert.doesNotMatch(publicApiJs, /'progress_photo\.logged'/);
});

test('the write core rejects a url that is neither a local upload nor http(s)', () => {
  // A javascript: or data: value would end up in an <img src> on the
  // timeline, so this is a real check, not input hygiene theatre.
  assert.match(addToolJs, /startsWith\('\/uploads\/'\)/);
  assert.match(addToolJs, /\^https\?:\\\/\\\//);
});

test('the read core filters to photos and hides soft-deleted rows', () => {
  assert.match(listToolJs, /kind = 'photo'/);
  assert.match(listToolJs, /deleted_at IS NULL/);
});

test('Progress is a real route but deliberately not a nav tab', () => {
  assert.match(appSvelte, /import Progress\s+from '\.\/routes\/Progress\.svelte'/);
  assert.match(appSvelte, /'\/progress':\s*Progress,/);
  // Occasional-use content: reached from Statistics and the Body Stats
  // sheet, so it should not be taking a primary nav slot. Checked against
  // the tab list specifically, not the whole file, since the active-state
  // mapping below legitimately mentions the route.
  const tabs = bottomNav.match(/BASE_TABS = \[([\s\S]*?)\]/)[1];
  assert.doesNotMatch(tabs, /\/progress/);
});

test('tapping a photo opens the scrubber with the whole set, not one image', () => {
  // The viewer scrubs across every photo, so a dispatch carrying only the
  // tapped tile would leave it with nothing to travel through. The list and
  // the weights are already loaded in the timeline, so they ride along
  // rather than costing the viewer a second fetch.
  const progressSvelte = read('../src/routes/Progress.svelte');
  const timeline = read('../src/components/progress-photos/ProgressPhotosTimeline.svelte');
  assert.match(timeline, /dispatch\('view', \{ photo, photos, statsByDate \}\)/);
  assert.match(progressSvelte, /import PhotoScrubber/);
  assert.match(progressSvelte, /photos=\{viewing\.photos\}/);
  // The old tap-to-enlarge sheet was replaced, not left behind beside it.
  assert.doesNotMatch(progressSvelte, /class="single"/);
});

test('the scrub track is a real date axis, not one even step per photo', () => {
  // Evenly spacing the ticks would quietly hide a three-month gap in the
  // record, which is exactly the thing worth seeing on a progress timeline.
  const scrubber = read('../src/components/progress-photos/PhotoScrubber.svelte');
  assert.match(scrubber, /\(times\[i\] - spanStart\) \/ \(spanEnd - spanStart\)/);
  // Every photo on one date leaves no span to divide by, so there has to be
  // a fallback rather than a division by zero stacking every tick at 0%.
  assert.match(scrubber, /degenerate/);
});

test('scrub preloads a window around the cursor rather than the whole set', () => {
  // Loading a year of photos up front on mobile data is the obvious wrong
  // answer; decoding them one at a time mid-drag is the other one.
  const scrubber = read('../src/components/progress-photos/PhotoScrubber.svelte');
  assert.match(scrubber, /PRELOAD_RADIUS/);
  assert.match(scrubber, /new Image\(\)/);
});

test('weights are rendered with their unit, not as a bare number', () => {
  // "182" is ambiguous and was the shipped behaviour; every other weight
  // surface in the app renders the configured unit alongside it.
  const timeline = read('../src/components/progress-photos/ProgressPhotosTimeline.svelte');
  const scrubber = read('../src/components/progress-photos/PhotoScrubber.svelte');
  for (const [name, src] of [['timeline', timeline], ['scrubber', scrubber]]) {
    assert.match(src, /weightUnit/, `${name} must know the unit`);
    assert.match(src, /\{\$weightUnit\}/, `${name} must render the unit`);
  }
});

test('quick weight log merges into the day rather than replacing it', () => {
  // PUT /api/body-stats/:date replaces the whole stats blob, so sending
  // { weight } alone would wipe a waist or body-fat figure logged that day.
  const wql = read('../src/components/progress-photos/WeightQuickLog.svelte');
  assert.match(wql, /GET|fetch\(`\/api\/body-stats\/\$\{date\}`/);
  assert.match(wql, /\.\.\.existing, weight: val/);
  assert.match(wql, /method: 'PUT'/);
  // The photo row must not grow its own copy of the weight.
  assert.doesNotMatch(wql, /body_stat_media|photos/);
});

test('quick weight log announces itself on the app-wide stats signal', () => {
  // Diary widget and the timeline both listen; without the event a weight
  // logged from a photo would not reach either until a manual reload.
  const wql = read('../src/components/progress-photos/WeightQuickLog.svelte');
  const timeline = read('../src/components/progress-photos/ProgressPhotosTimeline.svelte');
  assert.match(wql, /CustomEvent\('lt:body-stats-saved'\)/);
  assert.match(timeline, /addEventListener\('lt:body-stats-saved'/);
  assert.match(timeline, /removeEventListener\('lt:body-stats-saved'/);
});

test('capture can target a date other than today', () => {
  // Backfilling a camera roll should not mean walking the diary date by date.
  const timeline = read('../src/components/progress-photos/ProgressPhotosTimeline.svelte');
  assert.match(timeline, /let targetDate = todayStr\(\)/);
  assert.match(timeline, /uploadAndAttachPhoto\(file, day\)/);
  assert.doesNotMatch(timeline, /uploadAndAttachPhoto\(file, todayStr\(\)\)/);
  // A future date is not a thing a progress photo can have.
  assert.match(timeline, /max=\{todayStr\(\)\}/);
});

test('scrub delta recomputes after a weight is logged in place', () => {
  // Svelte tracks only what a reactive statement names, so the overrides map
  // has to be an argument. Reading it from the closure leaves the delta
  // computed from the old value while the number beside it shows the new one.
  const scrubber = read('../src/components/progress-photos/PhotoScrubber.svelte');
  assert.match(scrubber, /function weightAt\(date, overrides\)/);
  assert.match(scrubber, /weightAt\(current\.date, localWeights\)/);
  assert.match(scrubber, /weightAt\(p\.date, localWeights\)/);
});

test('both navs keep Statistics lit while on /progress', () => {
  // Without this the bottom nav falls through to its index-0 fallback and
  // highlights Diary, and the sidebar highlights nothing at all, on a page
  // that has nothing to do with either. Same treatment Coaching already
  // gets under Programs.
  const sidebar = read('../src/components/layout/Sidebar.svelte');
  for (const [name, src] of [['BottomNav', bottomNav], ['Sidebar', sidebar]]) {
    assert.match(src, /startsWith\('\/progress'\)/, `${name} should map /progress onto a tab`);
    assert.match(src, /'\/statistics'/, `${name} should map /progress onto Statistics`);
  }
});
