<script>
  import { disableAnimations, loopBannerAnimations } from '../../stores/settings.js';
  $: noAnim = $disableAnimations;
  $: noLoop = !$loopBannerAnimations;

  // Left-side decorative work-week strip — Mon..Fri only (Sat/Sun
  // dropped). Horizontally centered in the gap between the
  // page-header title ("Diary" ends ~x=100) and the notebook hero
  // (starts at x=462). Strip width = 5*46 + 4*8 = 262, midpoint of
  // the gap is x=281, so strip spans x=150..412 with ~50px clearance
  // on each side.
  // States: 'done', 'rest', 'today' (gets ring), 'pending'.
  const days = [
    { label: 'MON', x: 150, state: 'done'    },
    { label: 'TUE', x: 204, state: 'rest'    },
    { label: 'WED', x: 258, state: 'done'    },
    { label: 'THU', x: 312, state: 'done'    },
    { label: 'FRI', x: 366, state: 'today'   },
  ];

  // Right-side floating journal snippets — quick handwritten-style
  // notation that mirrors what a workout entry looks like. Slight
  // rotation per snippet for a notebook-margin scribble feel.
  const snippets = [
    { x: 770,  y: 30,  text: '5×5 @ 225',        rot: -2, size: 13 },
    { x: 900,  y: 22,  text: 'Bench PR!',         rot:  3, size: 14 },
    { x: 1030, y: 34,  text: '3×8 @ 135',         rot: -3, size: 12 },
    { x: 770,  y: 68,  text: '12,400 lb',         rot:  2, size: 14 },
    { x: 890,  y: 62,  text: '8 reps @ 8 RPE',    rot: -2, size: 12 },
    { x: 1060, y: 68,  text: '45m',               rot:  4, size: 14 },
    { x: 800,  y: 104, text: '4×12 cable rows',   rot:  3, size: 11 },
    { x: 990,  y: 106, text: '+10 lb',            rot: -4, size: 13 },
  ];
</script>

<!--
  Diary page banner — open notebook + pen is the hero (center).
  Desktop fills the sides with:
    LEFT  — 7-day mini calendar strip (this week's sessions)
    RIGHT — floating journal notation snippets (scribbled set/rep data)
  Mobile slice crops the sides and keeps the notebook centered.
-->
<svg
  class="diary-banner-svg"
  class:no-anim={noAnim}
  class:no-loop={noLoop}
  viewBox="0 0 1200 120"
  preserveAspectRatio="xMidYMid slice"
  xmlns="http://www.w3.org/2000/svg"
  aria-hidden="true"
>
  <defs>
    <radialGradient id="ltdb-glow" cx="50%" cy="50%" r="50%" gradientUnits="objectBoundingBox">
      <stop offset="0%"   stop-color="var(--accent)" stop-opacity="0.18" />
      <stop offset="100%" stop-color="var(--accent)" stop-opacity="0"    />
    </radialGradient>
    <linearGradient id="ltdb-page-grad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%"   stop-color="var(--accent)" stop-opacity="0.13" />
      <stop offset="100%" stop-color="var(--accent)" stop-opacity="0.04" />
    </linearGradient>
  </defs>

  <rect x="0" y="0" width="1200" height="120" fill="url(#ltdb-glow)" />

  <!-- ── LEFT: this-week calendar strip ─────────────────────────────
       Vertically centered in the banner (y=30..86, center=58). Each
       box is 46×56 with rounded corners and a 2px ring offset.
       Horizontal position lives in the days array. -->
  <g class="ltdb-week">
    {#each days as day, i}
      <g class="ltdb-day {day.state}" style="animation-delay: {(i * 0.06).toFixed(2)}s">
        <rect class="ltdb-day-box"   x={day.x} y="30" width="46" height="56" rx="7" />
        <rect class="ltdb-day-ring"  x={day.x - 2} y="28" width="50" height="60" rx="9" />
        <text class="ltdb-day-label" x={day.x + 23} y="48">{day.label}</text>
        {#if day.state === 'done'}
          <path class="ltdb-check" d={`M ${day.x + 14} 66 L ${day.x + 21} 73 L ${day.x + 34} 60`} />
        {:else if day.state === 'today'}
          <circle class="ltdb-today-dot" cx={day.x + 23} cy="68" r="4" />
        {:else if day.state === 'rest'}
          <line class="ltdb-rest-dash" x1={day.x + 16} y1="68" x2={day.x + 30} y2="68" />
        {:else}
          <circle class="ltdb-pending-dot" cx={day.x + 23} cy="68" r="2" />
        {/if}
      </g>
    {/each}
  </g>

  <!-- ── CENTER: open notebook + pen hero ─────────────────────────── -->
  <g transform="translate(350, 0)">
    <rect class="ltdb-page" x="112" y="8" width="130" height="104" rx="4" fill="url(#ltdb-page-grad)" />
    <rect class="ltdb-page" x="258" y="8" width="130" height="104" rx="4" fill="url(#ltdb-page-grad)" />

    <path class="ltdb-spine"
      d="M 242,9 C 244,36 256,36 258,9 M 242,111 C 244,84 256,84 258,111" fill="none" />
    <line class="ltdb-spine" x1="242" y1="9"  x2="242" y2="111" />
    <line class="ltdb-spine" x1="258" y1="9"  x2="258" y2="111" />

    <path class="ltdb-bookmark" d="M 368,8 L 380,8 L 380,34 L 374,28 L 368,34 Z" />

    <line class="ltdb-margin" x1="136" y1="16" x2="136" y2="104" />
    <line class="ltdb-margin" x1="274" y1="16" x2="274" y2="104" />

    <line class="ltdb-rule ll1" x1="122" y1="40" x2="230" y2="40" />
    <line class="ltdb-rule ll2" x1="122" y1="54" x2="230" y2="54" />
    <line class="ltdb-rule ll3" x1="122" y1="68" x2="230" y2="68" />
    <line class="ltdb-rule ll4" x1="122" y1="82" x2="230" y2="82" />
    <line class="ltdb-rule ll5" x1="122" y1="96" x2="196" y2="96" />
    <line class="ltdb-rule lr1" x1="282" y1="40" x2="376" y2="40" />
    <line class="ltdb-rule lr2" x1="282" y1="54" x2="376" y2="54" />
    <line class="ltdb-rule lr3" x1="282" y1="68" x2="376" y2="68" />
    <line class="ltdb-rule lr4" x1="282" y1="82" x2="345" y2="82" />

    <g class="ltdb-pen">
      <rect class="ltdb-pen-eraser" x="412" y="5" width="11" height="8" rx="2" />
      <line class="ltdb-pen-body"   x1="416" y1="13" x2="346" y2="83" />
      <path class="ltdb-pen-tip"    d="M 346,83 L 339,94 L 351,89 Z" />
    </g>

    <g class="ltdb-particles">
      <circle class="ltdb-particle p1" cx="342" cy="80" r="2"   />
      <circle class="ltdb-particle p2" cx="328" cy="88" r="1.5" />
      <circle class="ltdb-particle p3" cx="351" cy="91" r="1.8" />
      <circle class="ltdb-particle p4" cx="334" cy="74" r="1.3" />
    </g>
  </g>

  <!-- ── RIGHT: floating journal notation snippets ─────────────────── -->
  <g class="ltdb-snippets">
    {#each snippets as snip, i}
      <text
        class="ltdb-snip"
        x={snip.x} y={snip.y}
        font-size={snip.size}
        transform={`rotate(${snip.rot} ${snip.x} ${snip.y})`}
        style="animation-delay: {(0.6 + i * 0.07).toFixed(2)}s"
      >{snip.text}</text>
    {/each}
  </g>
</svg>

<style>
  .diary-banner-svg { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }

  /* ── Calendar strip ─────────────────────────────────────────────── */
  .ltdb-day {
    animation: ltdb-day-in 0.4s cubic-bezier(0.34, 1.2, 0.64, 1) both;
  }
  @keyframes ltdb-day-in {
    from { opacity: 0; transform: translateY(-6px); }
    to   { opacity: 1; transform: none; }
  }
  .ltdb-day-box {
    fill: var(--accent); fill-opacity: 0.08;
    stroke: var(--accent); stroke-opacity: 0.25; stroke-width: 1;
  }
  .ltdb-day-ring {
    fill: none; stroke: none;
  }
  .ltdb-day-label {
    fill: var(--accent); fill-opacity: 0.55;
    font-size: 9px; font-weight: 700; font-family: 'Inter', sans-serif;
    text-anchor: middle; letter-spacing: 0.10em;
  }
  /* Done — solid filled box + check */
  .ltdb-day.done .ltdb-day-box   { fill-opacity: 0.32; stroke-opacity: 0.50; }
  .ltdb-day.done .ltdb-day-label { fill-opacity: 0.85; }
  .ltdb-check {
    fill: none;
    stroke: var(--accent); stroke-opacity: 0.85;
    stroke-width: 2.4; stroke-linecap: round; stroke-linejoin: round;
  }
  /* Today — accent ring around the box + dot inside */
  .ltdb-day.today .ltdb-day-box   { fill-opacity: 0.22; stroke-opacity: 0.65; }
  .ltdb-day.today .ltdb-day-label { fill-opacity: 0.90; }
  .ltdb-day.today .ltdb-day-ring  {
    stroke: var(--accent); stroke-opacity: 0.6; stroke-width: 1.5;
    animation: ltdb-today-pulse 2.2s ease-in-out infinite 0.6s;
  }
  .ltdb-today-dot { fill: var(--accent); opacity: 0.9; animation: ltdb-today-pulse 2.2s ease-in-out infinite 0.6s; }
  @keyframes ltdb-today-pulse { 0%, 100% { stroke-opacity: 0.45; opacity: 0.6; } 50% { stroke-opacity: 0.85; opacity: 1; } }
  /* Rest — short dash mark */
  .ltdb-rest-dash { stroke: var(--accent); stroke-opacity: 0.45; stroke-width: 2; stroke-linecap: round; }
  /* Pending — small dot */
  .ltdb-pending-dot { fill: var(--accent); opacity: 0.35; }

  /* ── Notebook hero (unchanged styles) ─────────────────────────── */
  .ltdb-page { stroke: var(--accent); stroke-opacity: 0.2; stroke-width: 1; animation: ltdb-page-appear 0.4s ease both; }
  @keyframes ltdb-page-appear { from { opacity: 0; } to { opacity: 1; } }
  .ltdb-spine { stroke: var(--accent); stroke-opacity: 0.28; stroke-width: 1.2; }
  .ltdb-margin { stroke: var(--accent); stroke-opacity: 0.12; stroke-width: 0.8; stroke-dasharray: 3 5; }
  .ltdb-bookmark { fill: var(--accent); opacity: 0.28; }
  .ltdb-rule {
    stroke: var(--accent); stroke-opacity: 0.14; stroke-width: 0.9;
    stroke-dasharray: 110; stroke-dashoffset: 110;
    animation: ltdb-rule-draw 0.4s ease both;
  }
  .ll1 { animation-delay: 0.10s; } .ll2 { animation-delay: 0.18s; } .ll3 { animation-delay: 0.26s; }
  .ll4 { animation-delay: 0.34s; } .ll5 { animation-delay: 0.40s; }
  .lr1 { animation-delay: 0.14s; } .lr2 { animation-delay: 0.22s; } .lr3 { animation-delay: 0.30s; } .lr4 { animation-delay: 0.38s; }
  @keyframes ltdb-rule-draw { to { stroke-dashoffset: 0; } }
  .ltdb-pen { animation: ltdb-pen-arrive 0.5s cubic-bezier(0.34, 1.2, 0.64, 1) 0.48s both; }
  @keyframes ltdb-pen-arrive { from { transform: translate(28px, -28px); opacity: 0; } to { transform: translate(0, 0); opacity: 1; } }
  .ltdb-pen-body   { stroke: var(--accent); stroke-opacity: 0.55; stroke-width: 3.5; stroke-linecap: round; }
  .ltdb-pen-tip    { fill: var(--accent); opacity: 0.5; }
  .ltdb-pen-eraser { fill: var(--accent); opacity: 0.3; }
  .ltdb-particle { fill: var(--accent); opacity: 0.18; animation: ltdb-float 3s ease-in-out infinite; }
  .p1 { animation-delay: 0.0s; animation-duration: 2.9s; }
  .p2 { animation-delay: 0.7s; animation-duration: 3.4s; }
  .p3 { animation-delay: 1.3s; animation-duration: 2.7s; }
  .p4 { animation-delay: 2.0s; animation-duration: 3.2s; }
  @keyframes ltdb-float { 0%, 100% { transform: translateY(0); opacity: 0.18; } 50% { transform: translateY(-5px); opacity: 0.30; } }

  /* ── Journal snippets ─────────────────────────────────────────── */
  .ltdb-snip {
    fill: var(--accent); fill-opacity: 0.55;
    font-family: 'Caveat', 'Bradley Hand', 'Segoe Script', cursive;
    font-weight: 600;
    animation: ltdb-snip-in 0.5s cubic-bezier(0.34, 1.2, 0.64, 1) both;
  }
  @keyframes ltdb-snip-in {
    from { opacity: 0; }
    to   { opacity: 0.55; }
  }

  /* Reduced motion / no-anim toggles */
  .diary-banner-svg.no-loop .ltdb-particle,
  .diary-banner-svg.no-loop .ltdb-day.today .ltdb-day-ring,
  .diary-banner-svg.no-loop .ltdb-today-dot { animation-iteration-count: 1; animation-fill-mode: forwards; }
  .diary-banner-svg.no-anim .ltdb-page,
  .diary-banner-svg.no-anim .ltdb-pen,
  .diary-banner-svg.no-anim .ltdb-particle,
  .diary-banner-svg.no-anim .ltdb-day,
  .diary-banner-svg.no-anim .ltdb-day-ring,
  .diary-banner-svg.no-anim .ltdb-today-dot,
  .diary-banner-svg.no-anim .ltdb-snip { animation: none; opacity: 1; transform: none; }
  .diary-banner-svg.no-anim .ltdb-rule { animation: none; stroke-dashoffset: 0; }
  @media (prefers-reduced-motion: reduce) {
    .ltdb-page, .ltdb-pen, .ltdb-particle, .ltdb-day, .ltdb-day-ring, .ltdb-today-dot, .ltdb-snip { animation: none !important; }
    .ltdb-rule { animation: none !important; stroke-dashoffset: 0 !important; }
  }
</style>
