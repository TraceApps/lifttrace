/**
 * App icon shortcuts (from TraceApps/nutritrace#278): Start Workout and Log
 * Weight, from Android's launcher (res/xml/shortcuts.xml, lifttrace://new/…)
 * and the installed web app (the manifest's shortcuts, ./#/?new=…).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { parseAppLink } from '../src/lib/app-link.js';
import { oidcReturnHash } from '../server/lib/oidc-return.js';
import {
  SHORTCUT_KINDS, shortcutFromQuery, shortcutFromAppLink, isShortcutHash,
  shortcutRoute, shortcutNav, startWorkoutPlan,
} from '../src/lib/app-shortcut.js';

const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');

test('the links and addresses are read as their kind, and nothing else is', () => {
  assert.deepEqual(SHORTCUT_KINDS, ['workout', 'weight']);
  for (const k of SHORTCUT_KINDS) {
    assert.equal(shortcutFromAppLink(parseAppLink(`lifttrace://new/${k}`)), k);
    assert.equal(shortcutFromQuery(`?new=${k}`), k);
    assert.equal(shortcutFromQuery(`new=${k}`), k);
    assert.equal(isShortcutHash(`#/?new=${k}`), true);
  }
  assert.equal(shortcutFromAppLink(parseAppLink('LiftTrace://New/Workout/')), 'workout');
  assert.equal(shortcutFromAppLink(parseAppLink('lifttrace://new/barcode')), null);
  assert.equal(shortcutFromAppLink(parseAppLink('nutritrace://new/weight')), null, 'another app\'s link');
  assert.equal(shortcutFromAppLink(parseAppLink('lifttrace://oidc-callback/?token=x')), null);
  assert.equal(shortcutFromAppLink(null), null);
  assert.equal(shortcutFromQuery('?new=food'), null);
  assert.equal(shortcutFromQuery(undefined), null);
  assert.equal(isShortcutHash('#/programs?new=workout'), false, 'only the Diary\'s address');
  assert.equal(isShortcutHash('#/'), false);
});

test('a shortcut that starts the app is sent once, though Android reports it twice', () => {
  const t = 5_000_000;
  assert.equal(shortcutRoute('workout', t), '/?new=workout');
  assert.equal(shortcutRoute('workout', t + 400), null);
  assert.equal(shortcutRoute('weight', t + 500), '/?new=weight');
  assert.equal(shortcutRoute('weight', t + 3600), '/?new=weight');
  assert.equal(shortcutRoute('nope', t + 9000), null);
});

test('Start Workout: resume one under way, a new session after a finished one, Load Workout on an empty day', () => {
  const ex = [{ exercise_id: 1, sets: [] }];
  assert.deepEqual(startWorkoutPlan([], null), { action: 'load' });
  assert.deepEqual(startWorkoutPlan([], { id: 1, exercises: [] }), { action: 'load' });
  assert.deepEqual(startWorkoutPlan([{ id: 1, exercises: [] }], { id: 1, exercises: [] }), { action: 'load' });
  const one = { id: 1, exercises: ex, completed: 0 };
  assert.deepEqual(startWorkoutPlan([one], one), { action: 'resume' });
  assert.deepEqual(startWorkoutPlan([], one), { action: 'resume' }, 'no list: the open one decides');
  const done = { id: 1, exercises: ex, completed: 1 };
  assert.deepEqual(startWorkoutPlan([done], done), { action: 'new_session' });
  assert.deepEqual(startWorkoutPlan([], { ...done, completed: true }), { action: 'new_session' });
  // Issue #76 sessions: opened by date alone the day's first shows, and the
  // second, still going, is the one to open.
  const second = { id: 2, exercises: ex, completed: 0 };
  assert.deepEqual(startWorkoutPlan([done, second], done), { action: 'switch', id: 2 });
  assert.deepEqual(startWorkoutPlan([done, second], second), { action: 'resume' });
  const third = { id: 3, exercises: ex, completed: 0 };
  assert.deepEqual(startWorkoutPlan([one, done, third], one), { action: 'switch', id: 3 }, 'the latest one under way');
  assert.deepEqual(startWorkoutPlan([done, { id: 2, exercises: [], completed: 0 }], done), { action: 'new_session' }, 'an empty session isn\'t under way');
  assert.deepEqual(startWorkoutPlan([{ exercises: 'junk' }], null), { action: 'load' });
});

test('the installed web app lists the two shortcuts, in order', () => {
  const vite = read('../vite.config.js');
  const start = vite.indexOf('shortcuts: [');
  const block = vite.slice(start, vite.indexOf('],', start));
  const items = [...block.matchAll(/\{ name: '([^']+)', short_name: '([^']+)', url: '([^']+)', icons: \[\{ src: '([^']+)'/g)];
  assert.deepEqual(items.map(m => [m[1], m[2], m[3]]), [
    ['Start Workout', 'Start Workout', './#/?new=workout'],
    ['Log Weight', 'Log Weight', './#/?new=weight'],
  ]);
  for (const m of items) {
    assert.equal(shortcutFromQuery(m[3].split('?')[1]), m[3].split('=')[1]);
    assert.ok(existsSync(new URL('../public/' + m[4], import.meta.url)), m[4]);
  }
});

test('Android\'s shortcuts.xml: ids, labels, icons and explicit intents', () => {
  const xml = read('../android/app/src/main/res/xml/shortcuts.xml');
  const strings = read('../android/app/src/main/res/values/strings.xml');
  const blocks = [...xml.matchAll(/<shortcut\b([\s\S]*?)<\/shortcut>/g)].map(m => m[1]);
  const ids = [];
  const labels = [];
  for (const b of blocks) {
    const attr = n => (new RegExp(`android:${n}="([^"]*)"`).exec(b) || [])[1];
    ids.push(attr('shortcutId'));
    assert.equal(attr('enabled'), 'true');
    const label = /^@string\/(\w+)$/.exec(attr('shortcutShortLabel'))?.[1];
    const text = new RegExp(`<string name="${label}">([^<]+)</string>`).exec(strings)?.[1];
    assert.ok(text && text.length <= 25, `${label} exists and fits a launcher's short label`);
    labels.push(text);
    const icon = /^@drawable\/(\w+)$/.exec(attr('icon'))?.[1];
    assert.match(read(`../android/app/src/main/res/drawable/${icon}.xml`), /<vector[\s\S]*android:viewportWidth="24"[\s\S]*<path android:fillColor="@android:color\/white" android:pathData="M[^"]+" \/>/);
    assert.equal(attr('action'), 'android.intent.action.VIEW');
    assert.equal(attr('targetPackage'), 'com.lifttrace.app');
    assert.equal(attr('targetClass'), 'com.lifttrace.app.AppShortcutActivity', 'through the pass-through activity (app-shortcut-activity.test.js)');
    assert.equal(shortcutFromAppLink(parseAppLink(attr('data'))), attr('shortcutId'));
  }
  assert.deepEqual(ids, SHORTCUT_KINDS);
  assert.deepEqual(labels, ['Start Workout', 'Log Weight']);
  const manifest = read('../android/app/src/main/AndroidManifest.xml');
  assert.match(manifest, /<category android:name="android.intent.category.LAUNCHER" \/>\s*<\/intent-filter>\s*<meta-data android:name="android.app.shortcuts" android:resource="@xml\/shortcuts" \/>/);
  const browsable = manifest.match(/<intent-filter[^>]*>(?:(?!<\/intent-filter>)[\s\S])*BROWSABLE(?:(?!<\/intent-filter>)[\s\S])*<\/intent-filter>/g) || [];
  assert.ok(browsable.length);
  for (const f of browsable) assert.doesNotMatch(f, /android:host="new"/);
});

test('the app routes a shortcut link to the Diary, which opens it on today', () => {
  const app = read('../src/App.svelte');
  const handler = app.slice(app.indexOf("addListener('appUrlOpen'"));
  assert.match(handler, /if \(host === 'new'\) \{[\s\S]*?sc\.shortcutRoute\(sc\.shortcutFromAppLink\(link\)\)[\s\S]*?\[sc\.shortcutNav\(window\.location\.hash\)\]\(route\)[\s\S]*?return;/);
  assert.match(app, /App\.getLaunchUrl\?\.\(\)\.then\(async \(r\) => \{[\s\S]*?sc\.shortcutRoute\(sc\.shortcutFromAppLink\(parseAppLink\(r\.url\)\)\)/);
  const diary = read('../src/routes/Diary.svelte');
  assert.match(diary, /\$: _queueShortcut\(shortcutFromQuery\(\$querystring\)\);/);
  assert.match(diary, /function _queueShortcut\(kind\) \{\s*if \(!kind\) return;\s*replace\('\/'\);\s*_pendingShortcut = kind;\s*if \(!loading\) _runShortcut\(\);/);
  assert.match(diary, /loading = false;\s*\/\/[^\n]*\n\s*if \(_pendingShortcut\) _runShortcut\(\);/, 'one that came during the first load');
  const fn = diary.slice(diary.indexOf('async function _runShortcut'), diary.indexOf('async function _runShortcut') + 1700);
  assert.match(fn, /const today = localDateStr\(\);\s*if \(\$currentDate !== today\) \{\s*await loadWorkout\(today\);/);
  assert.match(fn, /if \(\(\$bodyStatsVisible \|\| \[\]\)\.includes\('weight'\)\) showBodyStats = true;\s*else \{ showToast\(\$_\('diary\.shortcut\.weight_hidden'\), 4000\); push\('\/settings\/workout'\); \}/);
  assert.match(fn, /await loadWorkoutSessions\(today\);[^\n]*\n\s*const plan = startWorkoutPlan\(\$todaySessions, \$todayLog\);\s*if \(plan\.action === 'switch'\) await handleSwitchSession\(plan\.id\);\s*else if \(plan\.action === 'load'\) openLoadWorkout\(\);\s*else if \(plan\.action === 'new_session'\) openLoadWorkoutForNewSession\(\);/);
  assert.ok(JSON.parse(read('../src/i18n/en.json')).diary.shortcut.weight_hidden);
});

test('signed out, the shortcut waits under the sign-in screen and opens after it', () => {
  const login = read('../src/routes/Login.svelte');
  assert.equal((login.match(/const shortcutWaiting = isShortcutHash\(window\.location\.hash\);/g) || []).length, 2);
  assert.equal((login.match(/if \(!shortcutWaiting\) push\('\/'\);/g) || []).length, 2);
  const app = read('../src/App.svelte');
  assert.match(app, /const shortcutWaiting = isShortcutHash\(window\.location\.hash\);\s*showSuccess\('Signed in'\);\s*await loadAuthState\(\);/);
  assert.match(app, /if \(!shortcutWaiting\) window\.location\.hash = '#\/';/);
});

test('a web SSO sign-in comes back to the shortcut waiting under it', () => {
  // The sign-in page sends its address after the #.
  assert.equal(oidcReturnHash('#/?new=weight', null, 'ok'), '/?new=weight&oidc=ok');
  assert.equal(shortcutFromQuery(oidcReturnHash('#/?new=weight', null, 'ok').split('?')[1]), 'weight');
  assert.equal(oidcReturnHash('#/', null, 'ok'), '/?oidc=ok', 'no longer #/#/?oidc=ok');
  assert.equal(oidcReturnHash('', 'access_denied'), '/?oidc_error=access_denied');
  assert.equal(oidcReturnHash('/profile', null, 'linked'), '/profile?oidc=linked');
  assert.equal(oidcReturnHash('settings', null, null), '/settings');
  assert.equal(oidcReturnHash('#', null, 'ok'), '/?oidc=ok');
  assert.match(read('../server/routes/oidc.js'), /res\.redirect\(`\$\{basePath\}\/#\$\{oidcReturnHash\(returnPath, error, ok\)\}`\);/);
});

test('a shortcut replaces the first page when the app just started, else Back returns', () => {
  for (const h of ['', '#', '#/', '/']) assert.equal(shortcutNav(h), 'replace', JSON.stringify(h));
  for (const h of ['#/settings', '#/?note=1', '#/foods?pick=1', '#/shopping', '#/statistics']) assert.equal(shortcutNav(h), 'push', h);
  assert.equal(shortcutNav(undefined), 'replace');
  const app = read('../src/App.svelte');
  assert.equal((app.match(/\(await import\('svelte-spa-router'\)\)\[sc\.shortcutNav\(window\.location\.hash\)\]\(route\);/g) || []).length, 2, 'the launch URL and appUrlOpen');
});
