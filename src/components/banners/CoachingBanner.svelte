<script>
  import { disableAnimations, loopBannerAnimations } from '../../stores/settings.js';
  $: noAnim = $disableAnimations;
  $: noLoop = !$loopBannerAnimations;
</script>

<!-- Coaching banner — tilted clipboard with a checklist ticking off in sequence -->
<svg class="co-banner-svg" class:no-anim={noAnim} class:no-loop={noLoop}
  viewBox="0 0 1200 120" preserveAspectRatio="xMidYMid slice"
  xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs>
    <radialGradient id="ltco-glow" cx="55%" cy="50%" r="42%" gradientUnits="objectBoundingBox">
      <stop offset="0%"   stop-color="var(--accent)" stop-opacity="0.20" />
      <stop offset="100%" stop-color="var(--accent)" stop-opacity="0" />
    </radialGradient>
  </defs>
  <rect x="0" y="0" width="1200" height="120" fill="url(#ltco-glow)" />

  <!-- Wrap existing art in a translate so it centers in the 1200-wide
       viewBox. Mobile crops the sides; desktop shows full + side glow. -->
  <g transform="translate(350, 0)">

  <!-- Ambient dots on the left side for balance -->
  <circle class="ltco-amb a1" cx="55"  cy="30"  r="1.4" />
  <circle class="ltco-amb a2" cx="90"  cy="95"  r="1.2" />
  <circle class="ltco-amb a3" cx="35"  cy="80"  r="1.3" />
  <circle class="ltco-amb a4" cx="450" cy="100" r="1.5" />
  <circle class="ltco-amb a5" cx="470" cy="24"  r="1.2" />

  <!-- Clipboard — slight tilt so it reads as a real object -->
  <g class="clipboard" transform="translate(160 6) rotate(-4 100 54)">
    <!-- Soft shadow -->
    <rect class="shadow" x="2" y="12" width="200" height="100" rx="7" />
    <!-- Board body -->
    <rect class="board"  x="0" y="10" width="200" height="100" rx="6" />
    <!-- Metal clip at the top -->
    <rect class="clip-base"  x="80" y="0"  width="40" height="14" rx="3" />
    <rect class="clip-inner" x="86" y="4"  width="28" height="6"  rx="1.5" />

    <!-- Title line -->
    <rect class="title" x="14" y="26" width="130" height="5" rx="2" />
    <rect class="title-sub" x="14" y="34" width="70"  height="3" rx="1.5" />

    <!-- Checklist rows -->
    <g class="row r1">
      <rect class="cbx" x="14" y="50" width="10" height="10" rx="2" />
      <path class="check" d="M16.5 55 l2.5 2.5 l4 -5" />
      <rect class="line" x="30" y="53" width="140" height="4" rx="2" />
    </g>
    <g class="row r2">
      <rect class="cbx" x="14" y="66" width="10" height="10" rx="2" />
      <path class="check" d="M16.5 71 l2.5 2.5 l4 -5" />
      <rect class="line" x="30" y="69" width="125" height="4" rx="2" />
    </g>
    <g class="row r3">
      <rect class="cbx" x="14" y="82" width="10" height="10" rx="2" />
      <path class="check" d="M16.5 87 l2.5 2.5 l4 -5" />
      <rect class="line" x="30" y="85" width="135" height="4" rx="2" />
    </g>
    <!-- Last row unchecked — "still to do" -->
    <g class="row r4">
      <rect class="cbx pending" x="14" y="98" width="10" height="10" rx="2" />
      <rect class="line" x="30" y="101" width="115" height="4" rx="2" />
    </g>
  </g>
  </g>
</svg>

<style>
  .co-banner-svg { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }

  /* Clipboard entry */
  .clipboard { animation: ltco-board-in 0.55s cubic-bezier(0.34, 1.15, 0.64, 1) both; transform-box: fill-box; }
  @keyframes ltco-board-in { from { opacity: 0; transform: translate(165px, 20px) rotate(-10deg); } to {} }

  .shadow      { fill: #000; fill-opacity: 0.20; filter: blur(3px); }
  .board       { fill: var(--accent); fill-opacity: 0.10; stroke: var(--accent); stroke-opacity: 0.45; stroke-width: 1.2; }
  .clip-base   { fill: var(--accent); fill-opacity: 0.30; stroke: var(--accent); stroke-opacity: 0.6; stroke-width: 1; }
  .clip-inner  { fill: var(--accent); fill-opacity: 0.6; }

  /* Title lines */
  .title     { fill: var(--accent); fill-opacity: 0.45; animation: ltco-title-pulse 2.8s ease-in-out infinite; }
  .title-sub { fill: var(--accent); fill-opacity: 0.25; }
  @keyframes ltco-title-pulse { 0%, 100% { fill-opacity: 0.45; } 50% { fill-opacity: 0.70; } }

  /* Rows: fade-in cascade */
  .row { animation: ltco-row-in 0.4s ease both; }
  .r1 { animation-delay: 0.18s; }
  .r2 { animation-delay: 0.28s; }
  .r3 { animation-delay: 0.38s; }
  .r4 { animation-delay: 0.48s; }
  @keyframes ltco-row-in { from { opacity: 0; transform: translateX(-6px); } to { opacity: 1; transform: none; } }

  .line { fill: var(--accent); fill-opacity: 0.22; }

  /* Checkboxes: outlined */
  .cbx         { fill: transparent; stroke: var(--accent); stroke-opacity: 0.45; stroke-width: 1.2; }
  .r1 .cbx,
  .r2 .cbx,
  .r3 .cbx     { fill: var(--accent); fill-opacity: 0.10; animation: ltco-cbx-fill 0.25s ease both; }
  .r1 .cbx { animation-delay: 0.55s; }
  .r2 .cbx { animation-delay: 0.80s; }
  .r3 .cbx { animation-delay: 1.05s; }
  @keyframes ltco-cbx-fill { from { fill-opacity: 0; } to { fill-opacity: 0.22; } }

  .cbx.pending { stroke-dasharray: 2 2; stroke-opacity: 0.35; }

  /* Checkmarks: draw-in, staggered */
  .check {
    fill: none; stroke: var(--accent); stroke-opacity: 0.95; stroke-width: 1.6;
    stroke-linecap: round; stroke-linejoin: round;
    stroke-dasharray: 12; stroke-dashoffset: 12;
    animation: ltco-check-draw 0.35s cubic-bezier(0.4, 1.2, 0.6, 1) both;
  }
  .r1 .check { animation-delay: 0.60s; }
  .r2 .check { animation-delay: 0.85s; }
  .r3 .check { animation-delay: 1.10s; }
  @keyframes ltco-check-draw { to { stroke-dashoffset: 0; } }

  /* Ambient floating dots */
  .ltco-amb { fill: var(--accent); opacity: 0.18; animation: ltco-float 3.4s ease-in-out infinite; }
  .a1 { animation-delay: 0s; }
  .a2 { animation-delay: 0.8s; }
  .a3 { animation-delay: 1.5s; }
  .a4 { animation-delay: 2.2s; }
  .a5 { animation-delay: 1.1s; }
  @keyframes ltco-float { 0%, 100% { transform: translateY(0); opacity: 0.18; } 50% { transform: translateY(-5px); opacity: 0.32; } }

  /* no-loop: freeze animations after first run */
  .co-banner-svg.no-loop .title,
  .co-banner-svg.no-loop .ltco-amb { animation-iteration-count: 1; animation-fill-mode: forwards; }

  /* no-anim: instant render */
  .co-banner-svg.no-anim .clipboard,
  .co-banner-svg.no-anim .row,
  .co-banner-svg.no-anim .cbx,
  .co-banner-svg.no-anim .check,
  .co-banner-svg.no-anim .title,
  .co-banner-svg.no-anim .ltco-amb {
    animation: none; opacity: 1; transform: none; stroke-dashoffset: 0;
  }

  @media (prefers-reduced-motion: reduce) {
    .clipboard, .row, .cbx, .check, .title, .ltco-amb {
      animation: none !important; opacity: 1 !important; transform: none !important;
      stroke-dashoffset: 0 !important;
    }
  }
</style>
