/**
 * Native code reads the local database read-write, and a failed read is
 * never a setting (same fix as NutriTrace d78db3be). After the app was
 * stopped mid-write, a read-only connection failed with
 * SQLITE_READONLY_ROLLBACK on every read until the app opened the database
 * again, and the reminder worker took that for "native reminders off".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const DIR = new URL('../android/app/src/main/java/com/lifttrace/app/', import.meta.url);
const read = f => readFileSync(new URL(f, DIR), 'utf8');

test('no native code opens the local database read-only', () => {
  for (const f of readdirSync(DIR).filter(f => /\.(java|kt)$/.test(f))) {
    assert.doesNotMatch(read(f), /OPEN_READONLY/, f);
  }
  assert.match(read('LocalDb.java'), /SQLiteDatabase\.OPEN_READWRITE/);
});

test('a setting that cannot be read is not "off"', () => {
  const s = read('WorkerScheduler.java');
  assert.match(s, /static Boolean readBoolSetting\(Context context, String key\)/);
  assert.match(s, /if \(v == ERROR\) return null;/);
  assert.match(read('ReminderWorker.java'), /if \(useNative == null\) \{/);
});
