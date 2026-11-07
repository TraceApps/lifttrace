/**
 * The Diary's set rows on a phone (issue #119 follow-up): every value shows
 * in full at 320 to 390px wide, with Track RPE on or off.
 *
 * At 320px with RPE on, the fixed columns (set number, done, RPE, remove)
 * and their gaps left 86px for weight and the second column together, so
 * reps, an L/R split, a 2000 m distance and a 1:30 hold all showed cut or
 * empty. Measured in Chromium and in an Android WebView (Chrome 124) for
 * every row kind at 320, 360 and 390px, RPE on and off, before and after.
 *
 * No browser runs here, so this does the grid's arithmetic from the
 * stylesheet's own numbers: if someone widens a fixed column, a gap or a
 * padding, or changes a share, the rows that would stop fitting fail.
 * Text widths are the ones measured (15px semibold).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const row = read('../src/components/diary/SetRow.svelte');
const card = read('../src/components/diary/ExerciseCard.svelte');
const { rowShape } = await import('../src/lib/workout.js');

const vars = (block) => Object.fromEntries([...block.matchAll(/--([\w-]+):\s*([\d.]+)(px|fr)/g)].map(m => [m[1], Number(m[2])]));
const between = (src, from, to = '\n  }\n') => { const a = src.indexOf(from); assert.ok(a >= 0, `missing ${from}`); return src.slice(a, src.indexOf(to, a)); };

const base = vars(between(row, '  .set-row {\n    --c-num'));
const phone = between(row, '@container sets (max-width: 340px)');
const narrowest = between(row, '@container sets (max-width: 280px)');
const P = vars(phone.slice(0, phone.indexOf('.set-row.hold')));
const line = (src, from) => src.slice(src.indexOf(from), src.indexOf('\n', src.indexOf(from)));
const holdShare = vars(line(phone, '.set-row.hold'));
const sidesShare = vars(line(phone, '.set-row.sides {'));
const N = vars(narrowest.slice(0, narrowest.indexOf('.set-row .lr-label')));
const holdShare280 = vars(line(narrowest, '.set-row.hold {'));
const sidesShare280 = vars(line(narrowest, '.set-row.sides {'));
const fieldPad = Number(phone.match(/\.set-field:not\(\.weight-field\) \{ padding: 0 (\d+)px; \}/)[1]);
const holdPad280 = Number(narrowest.match(/\.set-row\.hold \.set-field:not\(\.weight-field\) \{ padding: 0 (\d+)px; gap: (\d+)px; \}/)[1]);

// The sets list's content width at each phone width (measured): the page
// gutters, the card's border and the list's own 14px padding.
const LIST = { 320: 258, 360: 298, 390: 328 };
const BUTTON = 20; // the hold timer / L/R split button inside the field
const NEED = { side13: 27, reps3: 27, hold: 31, hours11px: 41, distance: 40, cal: 25, splitEach: 17, weight: 40, weight22: 33 };
// Weight field chrome: 2px border, 4px padding each side; the unit ("lbs",
// about 18px with its gap) unless the content is 72px or less; "ea" (about
// 14px with its gap) always for a per-hand weight; the ± buttons (about
// 50px) unless the content is 124px or less.
function weightRoom(field, paired) {
  const content = field - 10;
  let room = content;
  if (content > 124) room -= 50;
  if (content > 72) room -= paired ? 30 : 18;
  else if (paired) room -= 14;
  return room;
}

function columns(width, rpe, shape) {
  const narrow = width <= 340, v = width <= 280 ? { ...base, ...P, ...N } : narrow ? { ...base, ...P } : base;
  let w = 1.4, s = 0.7;
  if (shape.wide) { w = 1; s = 1; }
  if (narrow && (shape.hold || shape.uni)) { w = holdShare['c-w']; s = holdShare['c-s']; }
  if (width <= 280 && shape.hold) { w = holdShare280['c-w']; s = holdShare280['c-s']; }
  if (narrow && shape.sides) { const sh = width <= 280 ? sidesShare280 : sidesShare; w = sh['c-w']; s = sh['c-s']; }
  const fixed = v['c-num'] + v['c-check'] + v['c-rm'] + (rpe ? v['c-rpe'] : 0);
  const gaps = (rpe ? 5 : 4) * v['row-gap'];
  const fr = width - fixed - gaps;
  return { weight: fr * w / (w + s), second: fr * s / (w + s), pad: narrow ? fieldPad : 8 };
}

test('rows and their heading share one grid, chosen by the exercise', () => {
  assert.deepEqual(rowShape('reps', 'bilateral'), { wide: false, hold: false, uni: false, sides: false });
  assert.deepEqual(rowShape('reps', 'unilateral'), { wide: true, hold: false, uni: true, sides: false });
  assert.deepEqual(rowShape('time', 'bilateral'), { wide: true, hold: true, uni: false, sides: false });
  assert.deepEqual(rowShape('time', 'unilateral'), { wide: true, hold: true, uni: false, sides: true });
  assert.deepEqual(rowShape('distance', 'paired'), { wide: true, hold: false, uni: false, sides: false });
  for (const src of [row, card]) {
    assert.match(src, /class:rpe=\{\$trackRpe\} class:wide=\{shape\.wide\} class:hold=\{shape\.hold\} class:uni=\{shape\.uni\} class:sides=\{shape\.sides\}/);
  }
  // A row's grid used to follow what it held (:has(.split-btn), a hold
  // button only on unfinished sets), so rows of one card disagreed with
  // each other and with the heading.
  assert.doesNotMatch(row, /\.set-row:has\(/);
  assert.doesNotMatch(card, /\.sets-header[^{]*:has\(|:has\([^)]*\) \.sets-header/);
  assert.match(card, /container: sets \/ inline-size;/);
  assert.match(card, /\{#if \$trackRpe\}<span class="sh-rpe"><\/span>\{\/if\}/, 'the heading keeps the RPE column');
  assert.match(row, /\{:else if \$trackRpe\}\s*<!--[^>]*-->\s*<span class="rpe-slot"/, 'a warm-up keeps it too');
  // The heading repeats the phone values, the shares included.
  const head = between(card, '@container sets (max-width: 340px)');
  assert.deepEqual(vars(head.slice(0, head.indexOf('.sets-header.hold'))), P);
  assert.deepEqual(vars(line(head, '.sets-header.sides {')), sidesShare);
  assert.deepEqual(vars(line(between(card, '@container sets (max-width: 280px)'), '.sets-header.sides {')), sidesShare280);
});

for (const width of [320, 360, 390]) {
  for (const rpe of [false, true]) {
    test(`every value fits at ${width}px, RPE ${rpe ? 'on' : 'off'}`, () => {
      const W = LIST[width];
      const reps = columns(W, rpe, rowShape('reps', 'bilateral'));
      assert.ok(reps.second - 2 - 2 * reps.pad >= NEED.reps3, `reps 100: ${reps.second}`);
      // A weight field below 124px of content drops its ± buttons, below 72px its unit.
      assert.ok(weightRoom(reps.weight, false) >= NEED.weight, `weight 102.5: ${reps.weight}`);
      assert.ok(weightRoom(columns(W, rpe, rowShape('reps', 'paired')).weight, true) >= NEED.weight, 'per-hand 102.5 ea');
      const dist = columns(W, rpe, rowShape('distance', 'bilateral'));
      assert.ok(dist.second - 2 - 2 * dist.pad - (rpe ? 0 : 14) >= NEED.distance, `distance 2000: ${dist.second}`);
      assert.ok(dist.second - 2 - 2 * dist.pad >= NEED.cal);
      const hold = columns(W, rpe, rowShape('time', 'bilateral'));
      const hp = W <= 280 ? holdPad280 : hold.pad, hgap = W <= 280 ? 2 : 4;
      const timeRoom = hold.second - 2 - 2 * hp - BUTTON - hgap;
      assert.ok(timeRoom >= NEED.hold, `hold 1:30: ${hold.second}`);
      assert.ok(timeRoom >= (W <= 280 ? NEED.hours11px : 55), `hold 1:02:05: ${timeRoom}`);
      assert.ok(weightRoom(hold.weight, true) >= NEED.weight22, `hold weight 22.5 ea: ${hold.weight}`);
      assert.ok(weightRoom(hold.weight, false) >= NEED.weight, `hold weight 102.5: ${hold.weight}`);
      const uni = columns(W, rpe, rowShape('reps', 'unilateral'));
      const letters = W <= 280 ? 0 : 2 * 9;
      assert.ok((uni.second - 2 - 4 - BUTTON - 4 * 2 - letters) / 2 >= NEED.splitEach, `L/R split 12 / 10: ${uni.second}`);
      assert.ok(uni.weight - 10 >= NEED.weight - 8, `alternating weight 22.5: ${uni.weight}`);
      // An Alternating hold timed per side (issue #143): two times at 13px
      // and one button (the L and R letters go at 320px, as for reps), and
      // a weight per side beside it.
      const sides = columns(W, rpe, rowShape('time', 'unilateral'));
      // Measured on the next-up row, which is 8px narrower (its accent edge).
      const sideLetters = W <= 280 ? 0 : 2 * 7;
      const sideGaps = W <= 280 ? 2 * 2 : 4 * 1;
      const nextUp = 8 * (sides.second / (sides.second + sides.weight));
      assert.ok((sides.second - nextUp - 2 - 2 * 2 - BUTTON - sideGaps - sideLetters) / 2 >= NEED.side13, `L/R hold 0:45 / 0:40: ${sides.second}`);
      assert.ok(weightRoom(sides.weight, false) >= NEED.weight22, `per-side hold weight 22.5: ${sides.weight}`);
      // Its single time, with the split button and the timer beside it.
      assert.ok(sides.second - 2 - 2 * sides.pad - 2 * BUTTON - 2 * 4 >= NEED.hold, `single hold 1:30 with two buttons: ${sides.second}`);
    });
  }
}

test('the phone tap areas come after the base ones, so they win (the selectors weigh the same)', () => {
  const baseAt = row.indexOf('.set-row.rpe .remove-btn { --tap-dx: 3px; }');
  const phoneAt = row.indexOf('.set-row .remove-btn, .set-row.rpe .remove-btn { --tap-dx: 8px; }');
  const narrowAt = row.indexOf('.set-row .remove-btn, .set-row.rpe .remove-btn { --tap-dx: 9px; }');
  assert.ok(baseAt > 0 && phoneAt > baseAt && narrowAt > phoneAt, 'a 2px slip off the RPE chip deleted the set');
  const baseCheck = row.indexOf('.set-row.rpe .check-btn { --tap-w: calc(100% + 6px)');
  assert.ok(baseCheck > 0 && baseCheck < phoneAt);
});
