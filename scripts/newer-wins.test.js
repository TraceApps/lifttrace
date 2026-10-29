/**
 * server/lib/newer-wins.js: LiftTrace's routes on the shared rule
 * (lib/field-sync.js), keeping millisecond order within one second where
 * both times have it, and a request's per-field times (X-Field-Edits).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { decide, deleteLoses, editBringsBack, editAfterDelete, fieldEditsOf, deletedTimes } from '../server/lib/newer-wins.js';

const req = (h = {}) => ({ get: (k) => h[k.toLowerCase()] });
const T = (s) => `2026-10-01T12:00:${s}Z`;
const row = (times, extra = {}) => ({ name: 'n', notes: 'here', field_times: JSON.stringify(times), ...extra });
const F = { fields: ['name', 'notes'] };

test('within one second, the later time to the millisecond wins', () => {
  const here = row({ notes: T('10.500') });
  assert.equal(decide(req({ 'x-edited-at': T('10.400') }), here, { notes: 'edit' }, F).keep.has('notes'), true, 'here is later');
  assert.equal(decide(req({ 'x-edited-at': T('10.600') }), here, { notes: 'edit' }, F).keep.has('notes'), false, 'the edit is later');
  assert.equal(decide(req({ 'x-edited-at': T('10.500') }), here, { notes: 'edit' }, F).keep.has('notes'), false, 'a tie goes to the edit arriving');
  assert.equal(decide(req({ 'x-edited-at': T('11.000') }), here, { notes: 'edit' }, F).keep.has('notes'), false, 'a later second');
});

test('a field\'s own time (X-Field-Edits) is what the millisecond order compares', () => {
  const here = row({ notes: T('10.500') });
  const h = { 'x-edited-at': T('10.900'), 'x-field-edits': JSON.stringify({ notes: T('10.100') }) };
  assert.equal(decide(req(h), here, { notes: 'edit' }, F).keep.has('notes'), true);
  // The time kept for a field the edit didn't stamp is its own, not the one read.
  const { times } = decide(req(h), row({ notes: T('10.500') }), { name: 'renamed' }, F);
  assert.equal(JSON.parse(times).notes, T('10.500'));
});

test('X-Field-Edits: unreadable or oversized is ignored; no time later than the edit', () => {
  assert.equal(fieldEditsOf(req({ 'x-edited-at': T('10.000'), 'x-field-edits': 'nope' })), null);
  assert.equal(fieldEditsOf(req({ 'x-edited-at': T('10.000'), 'x-field-edits': '[1]' })), null);
  assert.equal(fieldEditsOf(req({ 'x-edited-at': T('10.000'), 'x-field-edits': JSON.stringify({ a: 'x'.repeat(9000) }) })), null);
  assert.deepEqual(fieldEditsOf(req({ 'x-edited-at': T('10.000'), 'x-field-edits': JSON.stringify({ name: T('20.000'), notes: 'no' }) })), { name: Date.parse(T('10.000')) });
});

test('a delete loses to a later edit, to the millisecond; a tie goes to the delete', () => {
  const here = row({ notes: T('10.500') });
  assert.equal(deleteLoses(req({ 'x-edited-at': T('10.400') }), here), T('10.500'));
  assert.equal(deleteLoses(req({ 'x-edited-at': T('10.500') }), here), null);
  assert.equal(deleteLoses(req({ 'x-edited-at': T('10.600') }), here), null);
  assert.equal(deleteLoses(req({ 'x-edited-at': T('10.600') }), row({})), null, 'no times: nothing to stand against');
});

test('an edit brings a deleted row back only when made after the delete, or now', () => {
  const at = Date.parse(T('10.500'));
  assert.equal(editAfterDelete(at, T('10.400')), true);
  assert.equal(editAfterDelete(at, T('10.500')), false, 'a tie keeps the delete');
  assert.equal(editAfterDelete(at, T('10.600')), false);
  assert.equal(editAfterDelete(at, null, '2026-10-01 12:00:09'), true, 'a delete kept to the second');
  assert.equal(editAfterDelete(at, null, '2026-10-01 12:00:10'), false, 'the same second: the delete');
  const gone = { deleted_at: '2026-10-01 12:00:10', field_times: deletedTimes(req({ 'x-edited-at': T('10.300') }), {}) };
  assert.equal(editBringsBack(req({ 'x-edited-at': T('10.200') }), gone), false);
  assert.equal(editBringsBack(req({ 'x-edited-at': T('10.400') }), gone), true);
  assert.equal(editBringsBack(req({}), gone), true, 'made now');
});
