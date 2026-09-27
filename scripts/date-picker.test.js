/**
 * The Diary's date picker marks each day from that day's own date
 * (issue #125, reported by @Scorch-Light).
 *
 * The workout dot came from a helper that worked the month out internally,
 * and the calendar never re-ran it when the arrows changed month: page back
 * from September and August showed September's dots. The month dropdown
 * looked fine only because it rebuilds the grid. Verified in a browser on
 * the arrows, the dropdown, a year boundary, a picked day and cardio days.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const diary = readFileSync(new URL('../src/routes/Diary.svelte', import.meta.url), 'utf8');
const cell = diary.slice(diary.indexOf('<button class="dp-day"'), diary.indexOf('</button>', diary.indexOf('<button class="dp-day"')));

test('every mark on a day reads that day\'s own date', () => {
  assert.match(diary, /\{@const dateStr = `\$\{calYear\}-\$\{String\(calMonth\+1\)\.padStart\(2,'0'\)\}-\$\{String\(day\)\.padStart\(2,'0'\)\}`\}/,
    'the cell works its date out from the month on show');
  assert.match(cell, /class:dp-today=\{dateStr === localDateStr\(\)\}/);
  assert.match(cell, /class:dp-sel=\{dateStr === \$currentDate\}/);
  assert.match(cell, /class:dp-has-workout=\{activeDateSet\.has\(dateStr\)\}/);
  assert.match(cell, /\{#if activeDateSet\.has\(dateStr\)\}<span class="dp-dot"><\/span>\{\/if\}/);
});

test('no mark hides the month inside a helper again', () => {
  assert.doesNotMatch(cell, /cal(HasWorkout|IsToday|IsSel)\(day\)/);
});
