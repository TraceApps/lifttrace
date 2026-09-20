<script context="module">
  /**
   * BodyFigure.svelte
   *
   * The silhouette and muscle regions behind MuscleRecovery's front/back
   * diagram, kept apart from that component so the path data does not bury
   * the recovery logic.
   *
   * Proportions follow the standard eight-head figure canon, which the
   * previous drawing did not: its hip landed 71% of the way down instead of
   * 50%, so the legs were about half the length they should have been, and
   * shoulders and waist were the same width. A torso that long with no
   * V-taper reads as a mannequin in a skirt no matter how the muscles are
   * coloured, which is why this was redrawn rather than tweaked.
   *
   * Landmarks (y): head 8..40, shoulder 51, waist 104, hip 136 (the true
   * midpoint), knee 190, ankle 250, sole 266. Shoulders span 66 units and
   * the waist 40, for roughly the 1.7:1 taper a human actually has.
   *
   * Muscle regions are clipped to the silhouette, so each one may overshoot
   * the body edge freely and still finish flush with it. That is what keeps
   * them aligned; hand-matching a muscle path to a limb edge is what
   * produced the offset slivers before.
   */

  // Silhouette. SOLID is drawn without a separation stroke because head,
  // neck and torso are one continuous mass: stroking between them draws a
  // collar, and the arc of it cuts a band across the jaw. CUT gets the
  // stroke, because limbs genuinely do need to read as in front of the torso.
  export const SOLID = [
    { t: 'ellipse', cx: 60, cy: 24, rx: 10.5, ry: 16 },
    { t: 'path', d: 'M 54 32 L 54 43 C 53 48, 46 50, 39 53 C 32 56, 27 61, 27 70 C 27 76, 30 79, 34 80 C 39 82, 41 88, 41 96 C 40 102, 40 106, 41 112 C 42 120, 39 124, 38 131 C 37 138, 41 142, 47 143 L 60 145 L 73 143 C 79 142, 83 138, 82 131 C 81 124, 78 120, 79 112 C 80 106, 80 102, 79 96 C 79 88, 81 82, 86 80 C 90 79, 93 76, 93 70 C 93 61, 88 56, 81 53 C 74 50, 67 48, 66 43 L 66 32 Z' },
  ];

  export const CUT = [
    'M 44 140 C 39 148, 38 162, 39 176 C 40 184, 41 188, 42 194 C 43 204, 42 216, 43 228 C 44 240, 45 250, 46 256 C 47 262, 53 263, 56 260 C 58 257, 57 250, 57 242 C 56 230, 56 218, 56 206 C 56 196, 57 188, 57 178 C 58 164, 59 150, 59 143 Z',
    'M 76 140 C 81 148, 82 162, 81 176 C 80 184, 79 188, 78 194 C 77 204, 78 216, 77 228 C 76 240, 75 250, 74 256 C 73 262, 67 263, 64 260 C 62 257, 63 250, 63 242 C 64 230, 64 218, 64 206 C 64 196, 63 188, 63 178 C 62 164, 61 150, 61 143 Z',
    'M 45 250 C 42 256, 42 264, 46 266 L 58 266 C 60 264, 59 257, 58 250 Z',
    'M 75 250 C 78 256, 78 264, 74 266 L 62 266 C 60 264, 61 257, 62 250 Z',
    'M 29 64 C 26 74, 25 86, 27 98 C 28 106, 27 110, 26 118 C 25 128, 26 138, 28 147 C 29 152, 32 155, 35 153 C 37 151, 37 148, 37 143 C 37 135, 38 127, 38 119 C 38 111, 39 105, 39 99 C 40 90, 40 80, 39 76 C 35 77, 31 72, 29 64 Z',
    'M 91 64 C 94 74, 95 86, 93 98 C 92 106, 93 110, 94 118 C 95 128, 94 138, 92 147 C 91 152, 88 155, 85 153 C 83 151, 83 148, 83 143 C 83 135, 82 127, 82 119 C 82 111, 81 105, 81 99 C 80 90, 80 80, 81 76 C 85 77, 89 72, 91 64 Z',
  ];

  const DELTS = 'M 39 57 C 32 58, 26 63, 25 71 C 25 79, 29 85, 34 85 C 39 84, 42 77, 42 69 C 42 63, 41 59, 39 57 Z M 81 57 C 88 58, 94 63, 95 71 C 95 79, 91 85, 86 85 C 81 84, 78 77, 78 69 C 78 63, 79 59, 81 57 Z';
  const UPPER_ARM = 'M 26 80 C 23 90, 23 102, 26 112 C 31 116, 37 111, 38 101 C 38 90, 33 78, 26 80 Z M 94 80 C 97 90, 97 102, 94 112 C 89 116, 83 111, 82 101 C 82 90, 87 78, 94 80 Z';
  const FOREARMS = 'M 25 116 C 22 126, 23 140, 27 150 C 32 153, 37 148, 37 138 C 37 128, 34 118, 30 114 Z M 95 116 C 98 126, 97 140, 93 150 C 88 153, 83 148, 83 138 C 83 128, 86 118, 90 114 Z';

  // Anterior: fan-shaped pecs, teardrop delt caps, a tapered ab column,
  // spindle biceps, teardrop quads.
  export const FRONT = [
    { key: 'shoulders', label: 'Shoulders', d: DELTS },
    { key: 'chest',     label: 'Chest',     d: 'M 40 57 C 47 54, 54 55, 58 59 L 59 83 C 50 86, 43 82, 40 74 C 38 68, 38 61, 40 57 Z M 80 57 C 73 54, 66 55, 62 59 L 61 83 C 70 86, 77 82, 80 74 C 82 68, 82 61, 80 57 Z' },
    { key: 'biceps',    label: 'Biceps',    d: UPPER_ARM },
    { key: 'forearms',  label: 'Forearms',  d: FOREARMS },
    { key: 'core',      label: 'Core',      d: 'M 48 86 C 53 84, 67 84, 72 86 C 73 96, 73 106, 71 116 C 70 126, 68 133, 60 136 C 52 133, 50 126, 49 116 C 47 106, 47 96, 48 86 Z' },
    { key: 'quads',     label: 'Quads',     d: 'M 40 148 C 36 160, 36 176, 40 190 C 45 196, 53 194, 56 186 C 58 174, 58 158, 56 147 C 50 144, 44 144, 40 148 Z M 80 148 C 84 160, 84 176, 80 190 C 75 196, 67 194, 64 186 C 62 174, 62 158, 64 147 C 70 144, 76 144, 80 148 Z' },
  ];

  // Posterior. `back` is one bucket covering lats, traps and rhomboids, so
  // it is one large region by design, shaped as a lat V with a notch at the
  // base rather than the rectangle it used to be.
  export const BACK = [
    { key: 'shoulders',  label: 'Shoulders',  d: DELTS },
    { key: 'back',       label: 'Back',       d: 'M 57 45 C 50 47, 44 53, 40 61 C 37 70, 38 82, 42 93 C 45 100, 50 105, 55 107 C 58 105, 60 101, 60 97 C 60 101, 62 105, 65 107 C 70 105, 75 100, 78 93 C 82 82, 83 70, 80 61 C 76 53, 70 47, 63 45 Z' },
    { key: 'triceps',    label: 'Triceps',    d: UPPER_ARM },
    { key: 'forearms',   label: 'Forearms',   d: FOREARMS },
    { key: 'glutes',     label: 'Glutes',     d: 'M 41 118 C 45 113, 53 112, 58 116 C 60 123, 60 132, 57 140 C 50 143, 43 141, 40 134 C 38 128, 38 122, 41 118 Z M 79 118 C 75 113, 67 112, 62 116 C 60 123, 60 132, 63 140 C 70 143, 77 141, 80 134 C 82 128, 82 122, 79 118 Z' },
    { key: 'hamstrings', label: 'Hamstrings', d: 'M 40 150 C 37 162, 37 178, 40 192 C 45 197, 53 195, 56 188 C 58 176, 58 162, 56 149 C 50 147, 44 147, 40 150 Z M 80 150 C 83 162, 83 178, 80 192 C 75 197, 67 195, 64 188 C 62 176, 62 162, 64 149 C 70 147, 76 147, 80 150 Z' },
    { key: 'calves',     label: 'Calves',     d: 'M 42 200 C 38 210, 38 224, 41 234 C 44 242, 50 244, 54 238 C 56 228, 56 212, 54 200 C 50 197, 45 197, 42 200 Z M 78 200 C 82 210, 82 224, 79 234 C 76 242, 70 244, 66 238 C 64 228, 64 212, 66 200 C 70 197, 75 197, 78 200 Z' },
  ];
</script>

<script>
  import { createEventDispatcher } from 'svelte';

  export let regions = FRONT;
  export let fillFor = () => 'transparent';
  export let dx = 0;
  export let clipId = 'mr-body';

  const dispatch = createEventDispatcher();
</script>

<g transform="translate({dx},0)">
  <g clip-path="url(#{clipId})">
    <g class="body-solid">
      {#each SOLID as s}
        {#if s.t === 'ellipse'}
          <ellipse cx={s.cx} cy={s.cy} rx={s.rx} ry={s.ry} />
        {:else}
          <path d={s.d} />
        {/if}
      {/each}
    </g>
    <g class="body-cut">
      {#each CUT as d}<path {d} />{/each}
    </g>
    {#each regions as r (r.key)}
      <path
        class="muscle"
        d={r.d}
        fill={fillFor(r.key)}
        role="button"
        tabindex="0"
        aria-label={r.label}
        on:mouseenter={() => dispatch('focus', r.key)}
        on:mouseleave={() => dispatch('blur')}
        on:click={() => dispatch('focus', r.key)}
        on:keydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); dispatch('focus', r.key); } }}
      />
    {/each}
  </g>
</g>
