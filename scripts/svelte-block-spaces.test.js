/**
 * Svelte drops the spaces at the very start and end of an {#if}, {#each},
 * {:else} ... block's content. A space written there next to text outside
 * the block never shows: "Week {n}{#if total} of {total}{/if}" reads
 * "Week 1of 4", "You{#if at} · {at}{/if}" reads "You· 2h ago". A space that
 * must show is written as {' '} (or {' · '}), which Svelte keeps.
 *
 * This compiles nothing; it reads every component with Svelte's own parser
 * and fails on a block whose content starts (or ends) with a space while the
 * block is written right against text or a tag outside it.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parse } from 'svelte/compiler';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function components(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...components(p));
    else if (name.endsWith('.svelte')) out.push(p);
  }
  return out;
}

const BLOCKS = new Set(['IfBlock', 'EachBlock', 'KeyBlock', 'AwaitBlock']);
const PARTS = ['consequent', 'alternate', 'body', 'fallback', 'fragment', 'pending', 'then', 'catch'];

/** Spaces Svelte will drop that sit right against content outside the block. */
export function droppedSpaces(src) {
  const ast = parse(src, { modern: true });
  const found = [];
  const lineOf = (i) => src.slice(0, i).split('\n').length;
  const glued = (c) => c !== undefined && !/\s/.test(c);
  // Whether the content just before (and after) each node is right against
  // it: the source character next to it, or, for the first (last) node of a
  // block's content, whatever is next to that whole block. Inside a tag's
  // own content the start and end are the tag's edges: nothing to join.
  const walkNodes = (nodes, edgeBefore, edgeAfter) => {
    nodes.forEach((n, i) => {
      const before = i === 0 ? edgeBefore : glued(src[n.start - 1]);
      const after = i === nodes.length - 1 ? edgeAfter : glued(src[n.end]);
      visit(n, before, after);
    });
  };
  const check = (frag, before, after) => {
    const nodes = frag.nodes;
    if (!nodes.length) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    // Text, or a space before an {expression}: a line break counts too,
    // since Svelte drops it all the same. A space before a tag is layout.
    const leads = /\S/.test(first.data) || nodes[1]?.type === 'ExpressionTag';
    if (before && first.type === 'Text' && /^\s/.test(first.data) && leads) {
      found.push(`line ${lineOf(first.start)}: ${JSON.stringify(src.slice(first.start, first.start + 40))}`);
    }
    if (after && last.type === 'Text' && /\s$/.test(last.data) && /\S/.test(last.data)) {
      found.push(`line ${lineOf(last.end)}: ${JSON.stringify(src.slice(Math.max(0, last.end - 40), last.end))}`);
    }
  };
  const visit = (n, before, after) => {
    if (!n || typeof n !== 'object') return;
    if (BLOCKS.has(n.type)) {
      for (const k of PARTS) {
        const frag = n[k];
        if (!frag?.nodes) continue;
        // An {:else if} is an IfBlock alone in the alternate: it takes the
        // whole chain's neighbours, and is checked as its own block.
        check(frag, before, after);
        walkNodes(frag.nodes, before, after);
      }
      return;
    }
    // A tag, component or snippet: its own content starts and ends at its edges.
    for (const k of Object.keys(n)) {
      if (k === 'parent' || k === 'metadata') continue;
      const v = n[k];
      if (v && typeof v === 'object' && Array.isArray(v.nodes)) walkNodes(v.nodes, false, false);
      else if (Array.isArray(v)) for (const c of v) if (c && typeof c === 'object' && c.type) visit(c, false, false);
    }
  };
  walkNodes(ast.fragment.nodes, false, false);
  return found;
}

test('the check catches the spaces Svelte drops, and passes the ones it keeps', () => {
  assert.equal(droppedSpaces('<span>Week {w}{#if t} of {t}{/if}</span>').length, 1);
  assert.equal(droppedSpaces('<span>You{#if at} · {at}{/if}</span>').length, 1);
  assert.equal(droppedSpaces('<p>{#if e}{e} · {/if}{s} MB</p>').length, 1);
  assert.equal(droppedSpaces('<p>z{#if a}A{:else if b} · B{/if}x</p>').length, 1);
  assert.equal(droppedSpaces('<p>{#if a}x{#if b}, {/if}{/if}y</p>').length, 1, 'a block at the end of a block');
  assert.equal(droppedSpaces('<p>\n  {#if a}x{#if b}, {/if}{/if}\n  {#if b}y{/if}\n</p>').length, 0, 'a line break after the outer block keeps a space');
  assert.equal(droppedSpaces("<span>Week {w}{#if t}{' of '}{t}{/if}</span>").length, 0);
  assert.equal(droppedSpaces('<span>{name}\n  {#if at} · {at}{/if}\n</span>').length, 0, 'a line break before the block keeps a space');
  assert.equal(droppedSpaces('<span>You{#if a}\n  · {a}{/if}</span>').length, 1, 'a line break inside the block is dropped too');
  assert.equal(droppedSpaces('<span>{#if a}{a} ·\n{/if}{b}</span>').length, 1);
  assert.equal(droppedSpaces('<div>\n  {#if a}\n    <b>x</b>\n  {/if}\n</div>').length, 0);
});

test('no component writes a space Svelte drops next to the text around it', () => {
  const bad = [];
  for (const file of components(join(ROOT, 'src'))) {
    for (const hit of droppedSpaces(readFileSync(file, 'utf8'))) bad.push(`${relative(ROOT, file)} ${hit}`);
  }
  assert.deepEqual(bad, [], "write the space as {' '} so it shows");
});

test("the Diary's program week reads from the translations", () => {
  const diary = readFileSync(join(ROOT, 'src/routes/Diary.svelte'), 'utf8');
  assert.doesNotMatch(diary, /Week \{\$todayLog/, 'no English week label left in the Diary');
  assert.doesNotMatch(diary, /\}-week program/);
  assert.equal(diary.match(/\$_\('programs\.week_of', \{ values: \{ week: \$todayLog\.program_week, total: \$todayLog\.program_duration_weeks \} \}\)/g)?.length, 2);
  const en = JSON.parse(readFileSync(join(ROOT, 'src/i18n/en.json'), 'utf8'));
  assert.equal(en.programs.week_of, 'Week {week} of {total}');
  assert.equal(en.workout_editor.week, 'Week {n}');
});
