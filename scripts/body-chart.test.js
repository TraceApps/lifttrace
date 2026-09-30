/**
 * The Body Measurements chart (issue #131, reported by @Scorch-Light).
 *
 * Weight and the overlay (body fat, waist...) were each spread evenly by
 * their own count, so the two rarely lined up: a body-fat reading taken the
 * same day as a weigh-in was drawn somewhere else. They now share one time
 * axis. With no overlay picked the chart also had no key and no numbers, and
 * every dot on the line charts was squashed into an oval by the stretched
 * SVG. Verified in a browser against a running server, desktop and phone.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const stats = read('../src/routes/Statistics.svelte');

// The chart helpers are private to the page, so they are read out of it.
const grab = (start) => {
  const at = stats.indexOf(start);
  assert.ok(at >= 0, start);
  return stats.slice(at, stats.indexOf('\n  }\n', at) + 4);
};
const helpers = new Function(`
  ${stats.match(/const _dayNum = [^\n]+/)[0]}
  ${grab('function _bwDomain(')}
  ${grab('function _bwX(')}
  ${grab('function _bwPointObjs(')}
  ${grab('function _overlayPointObjs(')}
  return { _bwDomain, _bwPointObjs, _overlayPointObjs };
`)();

const weights = [
  { date: '2025-06-11', weight: 120 }, { date: '2025-08-13', weight: 119 },
  { date: '2025-09-01', weight: 117.3 }, { date: '2026-07-20', weight: 121 }, { date: '2026-09-21', weight: 121.55 },
];
const fat = [
  { date: '2025-06-11', v: 30.7 }, { date: '2025-08-13', v: 30.1 }, { date: '2025-11-05', v: 29.8 },
  { date: '2026-07-20', v: 29.9 }, { date: '2026-09-21', v: 29.3 },
];

test('a body-fat reading sits over the weigh-in taken the same day', () => {
  const domain = helpers._bwDomain(weights, fat);
  const w = helpers._bwPointObjs(weights, domain, 200);
  const f = helpers._overlayPointObjs(fat, domain, 200);
  for (const d of ['2025-06-11', '2025-08-13', '2026-07-20', '2026-09-21']) {
    assert.equal(f[fat.findIndex(p => p.date === d)].x, w[weights.findIndex(p => p.date === d)].x, d);
  }
});

test('the axis runs by date, edge to edge, across both series', () => {
  const domain = helpers._bwDomain(weights, [{ date: '2026-10-01', v: 29 }]);
  const w = helpers._bwPointObjs(weights, domain, 200);
  assert.equal(w[0].x, 10, 'the earliest day starts the chart');
  assert.ok(w.at(-1).x < 190, 'a later overlay reading ends it');
  const gap = (a, b) => w[b].x - w[a].x;
  assert.ok(gap(2, 3) > 10 * gap(1, 2), 'ten months apart reads wider than nineteen days');
});

test('one day, or one reading, sits in the middle', () => {
  const one = [{ date: '2026-09-21', weight: 120 }];
  assert.equal(helpers._bwPointObjs(one, helpers._bwDomain(one, []), 200)[0].x, 100);
  assert.deepEqual(helpers._bwPointObjs([], null, 200), []);
});

test('the weight key and its numbers show with no overlay picked', () => {
  const chart = stats.slice(stats.indexOf("$_('statistics.body_weight_trend')"), stats.indexOf("$_('statistics.history')"));
  assert.match(chart, /<div class="chart-legend">\s*<span class="legend-item"><span class="legend-swatch accent"><\/span>\{\$_\('settings_workout\.body_stats\.weight'\)\}/,
    'the weight entry is not inside an {#if overlayMetric}');
  assert.match(chart, /\{#if weightMarks\}\s*<div class="overlay-axis"/);
  assert.match(stats, /\$: weightMarks = \(\(\) => \{\s*if \(!bodyWeights\.length\) return null;/);
});

test('no line chart draws its dots as circles it then stretches', () => {
  const lineCharts = [...stats.matchAll(/<svg class="line-chart"[\s\S]*?<\/svg>/g)].map(m => m[0]);
  assert.equal(lineCharts.length, 2);
  for (const svg of lineCharts) {
    assert.doesNotMatch(svg, /<circle/);
    assert.match(svg, /class="chart-dots"/);
    for (const pl of svg.match(/<polyline[\s\S]*?\/>/g)) assert.match(pl, /vector-effect="non-scaling-stroke"/);
  }
  assert.match(stats, /\.chart-dots \{ fill: none; stroke-linecap: round; vector-effect: non-scaling-stroke; \}/);
  const detail = read('../src/routes/ExerciseDetail.svelte');
  const svg = detail.match(/<svg class="progress-svg"[\s\S]*?<\/svg>/)[0];
  assert.doesNotMatch(svg, /<circle/);
  assert.match(svg, /stroke-linecap="round" vector-effect="non-scaling-stroke"/);
});
