<script>
  // Front + back body views, each muscle shaded 0…4 by how hard it was
  // worked in the current range. Shading is relative to the hardest-
  // worked muscle in the same load — the map answers "am I balanced",
  // not "how much did I lift".
  //
  // Geometry is ~90 KB, so bodyPaths.js is imported dynamically the
  // first time a map renders. Until it lands the component keeps its
  // height (aspect-ratio placeholder) so nothing below jumps on arrival.
  //
  // Ported from openGym's BodyMap.jsx (AGPL-3.0); SVG paths from
  // MuscleMap by Melih Colpan (MIT). See src/lib/bodyPaths.js.

  import { onMount } from 'svelte';
  import { MUSCLES, INERT, MUSCLE_NAME, levelsOf } from '../../lib/muscles.js';

  export let load = {};
  export let body = 'male';   // 'male' | 'female'

  let paths = null;
  onMount(async () => {
    try {
      const m = await import('../../lib/bodyPaths.js');
      paths = m.default;
    } catch {}
  });

  $: levels = levelsOf(load);
  $: geo = paths && (paths[body] || paths.male);
</script>

<div class="bodymap">
  {#if geo}
    {#each ['front', 'back'] as which}
      {@const view = geo[which]}
      <svg class="bm-v" viewBox={view.vb} role="img" aria-label="Body map, {which} view">
        {#each INERT as slug}
          {#each (view.p[slug] || []) as d, i (slug + i)}
            <path class="bm-sil" {d} />
          {/each}
        {/each}
        {#each MUSCLES as slug}
          {#each (view.p[slug] || []) as d, i (slug + i)}
            <path class="bm-m l{levels[slug] || 0}" {d}>
              <title>{MUSCLE_NAME[slug]}{load[slug] ? ` — ${(load[slug]).toFixed(1)} sets` : ''}</title>
            </path>
          {/each}
        {/each}
      </svg>
    {/each}
  {:else}
    <!-- Placeholder holds the layout height while ~90 KB of geometry
         loads on first render. Two aspect-ratio blocks matching the
         actual front + back viewBox proportions. -->
    <div class="bm-ph" aria-hidden="true"></div>
    <div class="bm-ph" aria-hidden="true"></div>
  {/if}
</div>

<style>
  .bodymap {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    align-items: start;
  }
  .bm-v, .bm-ph {
    width: 100%;
    aspect-ratio: 727 / 1280;
    display: block;
  }
  .bm-ph {
    background: color-mix(in srgb, var(--surface-2) 60%, transparent);
    border-radius: var(--radius-md);
  }
  /* Inert parts (head, hair, hands, feet, knees, ankles) — always
     drawn as silhouette so the figure is recognisable. */
  .bm-sil {
    fill: color-mix(in srgb, var(--text-3) 25%, transparent);
    stroke: none;
  }
  /* Muscles — shaded by level. Same 5-step scale a heat-map would use
     so "more accent = more training" reads the same everywhere.
     Untrained (l0) is the same neutral as the inert silhouette so the
     eye focuses on what IS trained. */
  .bm-m {
    stroke: color-mix(in srgb, var(--text-3) 30%, transparent);
    stroke-width: 0.5;
    transition: fill var(--dur-fast, 150ms);
  }
  .bm-m.l0 { fill: color-mix(in srgb, var(--text-3) 25%, transparent); }
  .bm-m.l1 { fill: color-mix(in srgb, var(--accent) 25%, transparent); }
  .bm-m.l2 { fill: color-mix(in srgb, var(--accent) 50%, transparent); }
  .bm-m.l3 { fill: color-mix(in srgb, var(--accent) 75%, transparent); }
  .bm-m.l4 { fill: var(--accent); }

  @media (max-width: 480px) {
    .bodymap { gap: 6px; }
  }
</style>
