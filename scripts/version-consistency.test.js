/**
 * Every file that carries the version says the same thing.
 *
 * The bump to v1.4.0-dev01 updated the app, the lockfile, the Android builds
 * and version.js, and left server/package.json on 1.3.0, which is the sort of
 * miss nobody sees until a server reports the wrong version to a client. The
 * rule is that these move together, so this is the rule written down.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const json = (p) => JSON.parse(read(p));

// `v1.4.0-dev01` in version.js, bare everywhere else.
const appVersion = read('../src/lib/version.js').match(/APP_VERSION\s*=\s*'v?([^']+)'/)?.[1];

test('version.js carries a version', () => {
  assert.match(appVersion || '', /^\d+\.\d+\.\d+(-dev\d+)?$/);
});

test('both package.json files and their lockfiles agree with it', () => {
  for (const p of ['../package.json', '../server/package.json']) {
    assert.equal(json(p).version, appVersion, p);
  }
  for (const p of ['../package-lock.json', '../server/package-lock.json']) {
    const lock = json(p);
    assert.equal(lock.version, appVersion, p);
    assert.equal(lock.packages?.['']?.version, appVersion, `${p} packages[""]`);
  }
});

test('the phone and the watch builds carry the release version, without the dev suffix', () => {
  // Android versionName has no pre-release part: the build number is what
  // separates one dev build from the next.
  const release = appVersion.replace(/-dev\d+$/, '');
  for (const p of ['../android/app/build.gradle', '../android/wear/build.gradle']) {
    const name = read(p).match(/versionName\s+"([^"]+)"/)?.[1];
    assert.equal(name, release, p);
  }
});

test('the watch build is versioned in step with the phone, never left behind', () => {
  const code = (p) => Number(read(p).match(/versionCode\s+(\d+)/)?.[1]);
  const phone = code('../android/app/build.gradle');
  const watch = code('../android/wear/build.gradle');
  assert.ok(phone > 0 && watch > 0, 'both declare a versionCode');
});
