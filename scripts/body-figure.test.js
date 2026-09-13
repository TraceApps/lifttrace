/**
 * Proportion guards for the muscle-recovery figure.
 *
 * The drawing this replaced failed on measurable geometry, not taste: its
 * hip sat 71% of the way down the body instead of 50%, so the legs were
 * roughly half the length they should be, and its shoulders and waist were
 * the same width. These assertions pin the two numbers that were wrong, so
 * a later tweak to the path data cannot quietly reintroduce either.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const src = readFileSync(new URL('../src/components/statistics/BodyFigure.svelte', import.meta.url), 'utf8');

/** Every "x y" coordinate pair in a path's d attribute. */
function points(d) {
  const nums = d.match(/-?\d+(?:\.\d+)?/g).map(Number);
  const out = [];
  for (let i = 0; i + 1 < nums.length; i += 2) out.push({ x: nums[i], y: nums[i + 1] });
  return out;
}

const TORSO = src.match(/\{ t: 'path', d: '([^']+)' \}/)[1];
const CUT = [...src.matchAll(/^ {4}'(M [^']+)',$/gm)].map((m) => m[1]);

// Canonical landmarks this figure is built on: crown y=8, sole y=266.
const CROWN = 8;
const SOLE = 266;
const HEIGHT = SOLE - CROWN;

test('the hip lands at the midpoint of the body, not two-thirds down', () => {
  // The legs are the first two entries in CUT. Their topmost point is the
  // hip, which on a human is the halfway mark head to heel.
  const legTops = CUT.slice(0, 2).map((d) => Math.min(...points(d).map((p) => p.y)));
  for (const top of legTops) {
    const pct = ((top - CROWN) / HEIGHT) * 100;
    assert.ok(pct > 43 && pct < 57,
      `hip should sit near 50% of body height, got ${pct.toFixed(1)}% (y=${top})`);
  }
});

test('shoulders are meaningfully wider than the waist', () => {
  const pts = points(TORSO);
  // Widest point of the torso is the deltoid line; the waist is the
  // narrowest band between the ribcage and the hips.
  const shoulderX = Math.min(...pts.filter((p) => p.y > 50 && p.y < 80).map((p) => p.x));
  const waistX = Math.min(...pts.filter((p) => p.y >= 95 && p.y <= 118).map((p) => p.x));
  const inset = waistX - shoulderX;
  assert.ok(inset >= 10,
    `waist should be inset at least 10 units from the shoulder line, got ${inset}`);

  const shoulderW = (60 - shoulderX) * 2;
  const waistW = (60 - waistX) * 2;
  assert.ok(shoulderW / waistW > 1.4,
    `shoulder-to-waist ratio should read as a taper, got ${(shoulderW / waistW).toFixed(2)}:1`);
});

test('the figure is drawn to roughly eight heads', () => {
  const head = src.match(/rx: ([\d.]+), ry: ([\d.]+)/);
  const headHeight = Number(head[2]) * 2;
  const heads = HEIGHT / headHeight;
  assert.ok(heads > 7 && heads < 9, `expected ~8 heads tall, got ${heads.toFixed(1)}`);
});

test('an untrained muscle is still distinguishable from the body', () => {
  // It used to be var(--surface-2), which is all but identical to the
  // silhouette fill, so anyone with no completed sets in the window saw a
  // featureless blob rather than a body map. That is the first thing a new
  // user sees, so it is the one state that most needs to read.
  const lib = readFileSync(new URL('../src/lib/muscle-recovery.js', import.meta.url), 'utf8');
  const untrained = lib.match(/label: 'Untrained', color: '([^']+)'/)[1];
  assert.notEqual(untrained, 'var(--surface-2)');
  assert.match(untrained, /color-mix/);

  const bodyPct = Number(
    readFileSync(new URL('../src/components/statistics/MuscleRecovery.svelte', import.meta.url), 'utf8')
      .match(/\.body-solid\)\s*\{\s*fill: color-mix\(in srgb, var\(--text-3\) (\d+)%/)[1],
  );
  const untrainedPct = Number(untrained.match(/(\d+)%/)[1]);
  assert.ok(untrainedPct >= bodyPct + 10,
    `untrained (${untrainedPct}%) must be clearly above the body fill (${bodyPct}%)`);
});
