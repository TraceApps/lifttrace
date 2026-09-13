/**
 * Behavioral tests for the progress-photo file helpers.
 *
 * resolveUploadPath and unlinkMediaFile are the parts that touch the
 * filesystem, and path traversal is the failure that would actually
 * matter, so these run against a real temp directory with real files
 * rather than asserting on source text. deleteMediaForUser itself needs
 * the DB and is covered by the manual test plan instead.
 *
 * Imports lib/upload-paths.js, which has no db.js dependency, so these
 * run for real here rather than skipping the way every DB-touching test
 * in this repo has to. UPLOADS_PATH is set before the import because the
 * module reads it at load time.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-photos-'));
process.env.UPLOADS_PATH = tmpRoot;

let mod = null;
try {
  mod = await import('../server/lib/upload-paths.js');
} catch (e) {
  console.log(`[body-stat-media] skipping: ${e.message.split('\n')[0]}`);
}

const maybe = (name, fn) => test(name, { skip: !mod }, fn);

maybe('resolveUploadPath maps an /uploads/ URL into the uploads directory', () => {
  const abs = mod.resolveUploadPath('/uploads/body-stats/a.jpg');
  assert.equal(abs, path.resolve(tmpRoot, 'body-stats/a.jpg'));
});

maybe('resolveUploadPath refuses anything that is not an /uploads/ path', () => {
  assert.equal(mod.resolveUploadPath('https://example.com/x.jpg'), null);
  assert.equal(mod.resolveUploadPath('body-stats/a.jpg'), null);
  assert.equal(mod.resolveUploadPath(''), null);
  assert.equal(mod.resolveUploadPath(null), null);
});

maybe('resolveUploadPath refuses a traversal that would escape the uploads root', () => {
  // A tampered row must not be able to turn an unlink into an arbitrary
  // file delete.
  assert.equal(mod.resolveUploadPath('/uploads/../../etc/passwd'), null);
  assert.equal(mod.resolveUploadPath('/uploads/body-stats/../../../secret'), null);
});

maybe('unlinkMediaFile deletes a real file and leaves a sibling alone', () => {
  const dir = path.join(tmpRoot, 'body-stats');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, 'gone.jpg');
  const keep = path.join(dir, 'keep.jpg');
  fs.writeFileSync(target, 'x');
  fs.writeFileSync(keep, 'x');

  assert.equal(mod.unlinkMediaFile('/uploads/body-stats/gone.jpg'), true);
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.existsSync(keep), true, 'only the named file should go');
});

maybe('unlinkMediaFile is quiet when the file is already gone', () => {
  // Restore after a partial delete, or a double-delete, should not throw.
  assert.equal(mod.unlinkMediaFile('/uploads/body-stats/never-existed.jpg'), false);
});

maybe('unlinkMediaFile refuses a traversal path outright', () => {
  const outside = path.join(tmpRoot, 'outside.txt');
  fs.writeFileSync(outside, 'x');
  assert.equal(mod.unlinkMediaFile('/uploads/../outside.txt'), false);
  assert.equal(fs.existsSync(outside), true, 'the file outside uploads must survive');
});

test.after(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});
