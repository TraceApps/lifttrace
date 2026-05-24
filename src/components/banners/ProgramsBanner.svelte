<script>
  import { disableAnimations, loopBannerAnimations } from '../../stores/settings.js';
  $: noAnim = $disableAnimations;
  $: noLoop = !$loopBannerAnimations;

  // 12-week × 3-session mesocycle calendar. Each cell = one session.
  // Active week (index 3, i.e. week 4) gets the brighter/pulsing class.
  const WEEKS = 12;
  const ROWS = 3;
  const CELL_W = 30;
  const CELL_H = 14;
  const CELL_GAP_X = 5;
  const CELL_GAP_Y = 5;
  const GRID_X0 = 40;
  const GRID_Y0 = 30;
  const ACTIVE_WEEK = 3;            // 4th week of the mesocycle (highlighted)

  // Build a flat list of cells so the template stays simple.
  const cells = [];
  for (let c = 0; c < WEEKS; c++) {
    for (let r = 0; r < ROWS; r++) {
      cells.push({
        x: GRID_X0 + c * (CELL_W + CELL_GAP_X),
        y: GRID_Y0 + r * (CELL_H + CELL_GAP_Y),
        active: c === ACTIVE_WEEK,
        delay: (c * 0.04 + r * 0.02).toFixed(2),
      });
    }
  }

  // Queued workout chips on the right — what's coming up next.
  const chips = [
    { x: 730, y: 22, w: 78,  label: 'Push 5×5'      },
    { x: 820, y: 22, w: 86,  label: 'Upper Hyper'   },
    { x: 920, y: 22, w: 92,  label: 'Lower Strength'},
    { x: 1024,y: 22, w: 78,  label: 'Pull 4×8'      },
    { x: 730, y: 56, w: 82,  label: 'Legs 3×10'     },
    { x: 824, y: 56, w: 74,  label: 'Deload'        },
    { x: 910, y: 56, w: 80,  label: 'AMRAP Fin'     },
    { x: 1002,y: 56, w: 100, label: 'Full Body B'   },
    { x: 760, y: 90, w: 74,  label: 'Tempo'         },
    { x: 846, y: 90, w: 90,  label: 'Conditioning'  },
    { x: 948, y: 90, w: 84,  label: 'Mobility'      },
    { x: 1044,y: 90, w: 72,  label: 'Rest'          },
  ];
</script>

<!--
  Programs banner — full mesocycle grid (left half) + fanned program
  cards (center) + queued workout chips (right half). The whole 1200
  viewBox is now used so desktop has content edge to edge; mobile slice
  centers on the cards.
-->
<svg class="pg-banner-svg" class:no-anim={noAnim} class:no-loop={noLoop}
  viewBox="0 0 1200 120" preserveAspectRatio="xMidYMid slice"
  xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs>
    <radialGradient id="ltpg-glow" cx="50%" cy="50%" r="50%" gradientUnits="objectBoundingBox">
      <stop offset="0%"   stop-color="var(--accent)" stop-opacity="0.18" />
      <stop offset="100%" stop-color="var(--accent)" stop-opacity="0" />
    </radialGradient>
  </defs>
  <rect x="0" y="0" width="1200" height="120" fill="url(#ltpg-glow)" />

  <!-- ── LEFT: 12-week mesocycle calendar grid ─────────────────────── -->
  <g class="ltpg-grid">
    {#each cells as cell, i}
      <rect
        class="ltpg-cell"
        class:active={cell.active}
        x={cell.x} y={cell.y}
        width={CELL_W} height={CELL_H}
        rx="2"
        style="animation-delay: {cell.delay}s"
      />
    {/each}
  </g>

  <!-- ── CENTER: fanned program cards (this-week stack) ────────────── -->
  <g class="ltpg-card card1">
    <rect x="540" y="46" width="86" height="58" rx="6" />
    <line x1="552" y1="64" x2="616" y2="64" />
    <line x1="552" y1="74" x2="610" y2="74" />
    <line x1="552" y1="84" x2="604" y2="84" />
  </g>
  <g class="ltpg-card card2">
    <rect x="570" y="36" width="86" height="58" rx="6" />
    <line x1="582" y1="54" x2="646" y2="54" />
    <line x1="582" y1="64" x2="640" y2="64" />
    <line x1="582" y1="74" x2="634" y2="74" />
  </g>
  <g class="ltpg-card card3">
    <rect x="600" y="26" width="86" height="58" rx="6" />
    <line x1="612" y1="44" x2="676" y2="44" />
    <line x1="612" y1="54" x2="670" y2="54" />
    <line x1="612" y1="64" x2="664" y2="64" />
  </g>

  <!-- ── RIGHT: queued-workout chip cloud ──────────────────────────── -->
  <g class="ltpg-chips">
    {#each chips as chip, i}
      <g class="ltpg-chip" style="animation-delay: {(0.4 + i * 0.05).toFixed(2)}s">
        <rect x={chip.x} y={chip.y} width={chip.w} height="20" rx="10" />
        <text x={chip.x + chip.w / 2} y={chip.y + 14}>{chip.label}</text>
      </g>
    {/each}
  </g>

  <!-- Floating particles -->
  <circle class="ltpg-dot pd1" cx="20"   cy="100" r="1.6" />
  <circle class="ltpg-dot pd2" cx="500"  cy="14"  r="1.5" />
  <circle class="ltpg-dot pd3" cx="680"  cy="108" r="1.6" />
  <circle class="ltpg-dot pd4" cx="1180" cy="14"  r="1.5" />
</svg>

<style>
  .pg-banner-svg { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }

  /* Mesocycle grid cells */
  .ltpg-cell {
    fill: var(--accent);
    fill-opacity: 0.10;
    animation: ltpg-cell-fade 0.4s ease both;
  }
  .ltpg-cell.active {
    fill-opacity: 0.32;
    animation: ltpg-cell-fade 0.4s ease both, ltpg-cell-pulse 3s ease-in-out infinite 0.6s;
  }
  @keyframes ltpg-cell-fade { from { opacity: 0; } to { opacity: 1; } }
  @keyframes ltpg-cell-pulse { 0%, 100% { fill-opacity: 0.32; } 50% { fill-opacity: 0.55; } }

  /* Fanned program cards */
  .ltpg-card rect { fill: var(--accent); fill-opacity: 0.14; stroke: var(--accent); stroke-opacity: 0.40; stroke-width: 1; }
  .ltpg-card line { stroke: var(--accent); stroke-opacity: 0.32; stroke-width: 1.2; stroke-linecap: round; }
  .ltpg-card { animation: ltpg-card-slide 0.5s cubic-bezier(0.34, 1.2, 0.64, 1) both; }
  .card1 { animation-delay: 0.30s; }
  .card2 { animation-delay: 0.40s; }
  .card3 { animation-delay: 0.50s; }
  @keyframes ltpg-card-slide { from { opacity: 0; transform: translate(20px, 10px); } to { opacity: 1; transform: none; } }

  /* Queued workout chips */
  .ltpg-chip rect {
    fill: var(--accent);
    fill-opacity: 0.08;
    stroke: var(--accent);
    stroke-opacity: 0.30;
    stroke-width: 1;
  }
  .ltpg-chip text {
    fill: var(--accent);
    fill-opacity: 0.72;
    font-size: 10px;
    font-weight: 600;
    font-family: 'Inter', sans-serif;
    text-anchor: middle;
    letter-spacing: 0.02em;
  }
  .ltpg-chip {
    animation: ltpg-chip-in 0.45s cubic-bezier(0.34, 1.2, 0.64, 1) both;
  }
  @keyframes ltpg-chip-in {
    from { opacity: 0; transform: translateX(12px); }
    to   { opacity: 1; transform: none; }
  }

  .ltpg-dot { fill: var(--accent); opacity: 0.18; animation: ltpg-float 3.2s ease-in-out infinite; }
  .pd1 { animation-delay: 0s; } .pd2 { animation-delay: 0.9s; } .pd3 { animation-delay: 1.6s; } .pd4 { animation-delay: 2.2s; }
  @keyframes ltpg-float { 0%, 100% { transform: translateY(0); opacity: 0.18; } 50% { transform: translateY(-5px); opacity: 0.30; } }

  .pg-banner-svg.no-loop .ltpg-cell.active,
  .pg-banner-svg.no-loop .ltpg-dot { animation-iteration-count: 1; animation-fill-mode: forwards; }
  .pg-banner-svg.no-anim .ltpg-cell,
  .pg-banner-svg.no-anim .ltpg-card,
  .pg-banner-svg.no-anim .ltpg-chip,
  .pg-banner-svg.no-anim .ltpg-dot {
    animation: none;
    opacity: 1;
    transform: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .ltpg-cell, .ltpg-card, .ltpg-chip, .ltpg-dot {
      animation: none !important;
      opacity: 1 !important;
      transform: none !important;
    }
  }
</style>
