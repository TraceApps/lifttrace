<script>
  import { disableAnimations, loopBannerAnimations } from '../../stores/settings.js';
  $: noAnim = $disableAnimations;
  $: noLoop = !$loopBannerAnimations;

  // Generate a chunky gear silhouette: each tooth is a fat rectangular
  // wedge between innerR and outerR. Larger toothFrac = wider, blockier
  // teeth (matches the reference 3D-gear look the user wants).
  function gearPath(teeth, outerR, innerR) {
    const pts = [];
    const cycle = (2 * Math.PI) / teeth;
    const toothFrac = 0.58;           // tooth occupies 58% of each cycle (chunky)
    const toothSweep = cycle * toothFrac;
    for (let i = 0; i < teeth; i++) {
      const base = i * cycle;
      const a1 = base;
      const a2 = base + toothSweep;
      pts.push([innerR * Math.cos(a1), innerR * Math.sin(a1)]);
      pts.push([outerR * Math.cos(a1), outerR * Math.sin(a1)]);
      pts.push([outerR * Math.cos(a2), outerR * Math.sin(a2)]);
      pts.push([innerR * Math.cos(a2), innerR * Math.sin(a2)]);
    }
    return 'M ' + pts.map(p => p[0].toFixed(2) + ' ' + p[1].toFixed(2)).join(' L ') + ' Z';
  }

  // 5 chunky gears that fill the horizontal space between the toggle
  // columns with even gaps between gears AND between the outermost gears
  // and the adjacent pill columns. Sizes capped so every gear stays
  // within the visible y=20..100 range after slice cropping on the
  // widest realistic banner aspect (~15:1). Inner radius ≈ 73-75% of
  // outer → teeth depth ~25%, matches the chunky 3D-gear reference.
  const gearBig   = gearPath(10, 40, 30);
  const gearMed   = gearPath(9,  34, 25);
  const gearSm    = gearPath(8,  28, 21);
  const gearMini  = gearPath(7,  24, 18);
  const gearTiny  = gearPath(7,  20, 15);
</script>

<!--
  Settings page banner — one composition for all widths. Gear cluster
  is centered at x≈600 (viewBox horizontal center) so mobile slice
  crop keeps the hero front-and-centre; the sliders and toggle pills
  on the sides naturally fade off the edges on narrower viewports.
-->
<svg
  class="settings-banner-svg"
  class:no-anim={noAnim}
  class:no-loop={noLoop}
  viewBox="0 0 1200 120"
  preserveAspectRatio="xMidYMid slice"
  xmlns="http://www.w3.org/2000/svg"
  aria-hidden="true"
>
  <defs>
    <radialGradient id="stb-glow" cx="50%" cy="50%" r="55%" gradientUnits="objectBoundingBox">
      <stop offset="0%"   stop-color="var(--accent)" stop-opacity="0.16" />
      <stop offset="100%" stop-color="var(--accent)" stop-opacity="0"    />
    </radialGradient>
  </defs>

  <!-- Ambient glow -->
  <rect x="0" y="0" width="1200" height="120" fill="url(#stb-glow)" />

  <!-- Slider tracks (left two clusters: a 3-row stack and a 2-row stack) -->
  <!-- Cluster 1 — three sliders -->
  <rect class="stb-track" x="40"  y="30" width="180" height="4" rx="2" />
  <rect class="stb-fill  sf1"   x="40"  y="30" width="118" height="4" rx="2" />
  <circle class="stb-knob sk1"  cx="158" cy="32" r="8" />

  <rect class="stb-track" x="40"  y="58" width="180" height="4" rx="2" />
  <rect class="stb-fill  sf2"   x="40"  y="58" width="72"  height="4" rx="2" />
  <circle class="stb-knob sk2"  cx="112" cy="60" r="8" />

  <rect class="stb-track" x="40"  y="86" width="180" height="4" rx="2" />
  <rect class="stb-fill  sf3"   x="40"  y="86" width="145" height="4" rx="2" />
  <circle class="stb-knob sk3"  cx="185" cy="88" r="8" />

  <!-- Cluster 2 — two more sliders, far right beyond gear -->
  <rect class="stb-track" x="940" y="30" width="220" height="4" rx="2" />
  <rect class="stb-fill  sf4"   x="940" y="30" width="180" height="4" rx="2" />
  <circle class="stb-knob sk4"  cx="1120" cy="32" r="8" />

  <rect class="stb-track" x="940" y="86" width="220" height="4" rx="2" />
  <rect class="stb-fill  sf5"   x="940" y="86" width="90"  height="4" rx="2" />
  <circle class="stb-knob sk5"  cx="1030" cy="88" r="8" />

  <!-- Toggle switches (center column) -->
  <rect class="stb-toggle-track tt-on"  x="280" y="24" width="44" height="22" rx="11" />
  <circle class="stb-toggle-knob tk-on stk1" cx="313" cy="35" r="9" />

  <rect class="stb-toggle-track tt-off" x="280" y="58" width="44" height="22" rx="11" />
  <circle class="stb-toggle-knob tk-off stk2" cx="291" cy="69" r="9" />

  <rect class="stb-toggle-track tt-on"  x="280" y="92" width="44" height="22" rx="11" />
  <circle class="stb-toggle-knob tk-on stk3" cx="313" cy="103" r="9" />

  <!-- Second toggle column -->
  <rect class="stb-toggle-track tt-off" x="800" y="32" width="44" height="22" rx="11" />
  <circle class="stb-toggle-knob tk-off stk4" cx="811" cy="43" r="9" />

  <rect class="stb-toggle-track tt-on"  x="800" y="78" width="44" height="22" rx="11" />
  <circle class="stb-toggle-knob tk-on stk5" cx="833" cy="89" r="9" />

  <!-- ── GEAR CLUSTER in the center (x=600 ± 70). 4 gears of varying
       sizes positioned so their teeth interlock, rotating at speeds
       that respect real gear-ratio physics (smaller spins faster,
       neighbors spin opposite ways). Each gear uses a proper toothed
       SVG path silhouette — not floating rectangles around a circle.

       Positioning lives on the parent <g transform="translate(...)">;
       the CSS rotation animation lives on the child <g class="stb-gear-*">
       so CSS transform doesn't blow away the SVG positioning transform. -->

  <!-- ── GEAR CLUSTER — 5 gears with equal ~31px gaps between every
       gear edge AND between the outermost gear edges and the adjacent
       pill columns (left pill ends at x=324, right pill starts at
       x=800; cluster spans x=355..771).

       Sizes (R): 24, 40, 34, 28, 20 — big anchor sits left of centre,
       sizes step down both directions so the eye travels across the
       row naturally. Y positions alternate so the cluster has motion. -->

  <!-- Mini gear (R=24, 7 teeth) — leftmost. -->
  <g transform="translate(379,50)">
    <g class="stb-gear stb-gear-0">
      <path d={gearMini} />
      <circle class="stb-gear-hub" r="9" />
    </g>
  </g>

  <!-- Big gear (R=40, 10 teeth) — main anchor. -->
  <g transform="translate(474,60)">
    <g class="stb-gear stb-gear-1">
      <path d={gearBig} />
      <circle class="stb-gear-hub" r="15" />
    </g>
  </g>

  <!-- Medium gear (R=34, 9 teeth) — meshing right of big. -->
  <g transform="translate(579,54)">
    <g class="stb-gear stb-gear-2">
      <path d={gearMed} />
      <circle class="stb-gear-hub" r="13" />
    </g>
  </g>

  <!-- Small gear (R=28, 8 teeth) — offset down. -->
  <g transform="translate(672,70)">
    <g class="stb-gear stb-gear-3">
      <path d={gearSm} />
      <circle class="stb-gear-hub" r="10" />
    </g>
  </g>

  <!-- Tiny gear (R=20, 7 teeth) — rightmost, offset up. -->
  <g transform="translate(751,38)">
    <g class="stb-gear stb-gear-4">
      <path d={gearTiny} />
      <circle class="stb-gear-hub" r="7" />
    </g>
  </g>

  <!-- Floating particles scattered across width -->
  <circle class="stb-particle sp1" cx="20"   cy="14"  r="2"   />
  <circle class="stb-particle sp2" cx="240"  cy="105" r="1.5" />
  <circle class="stb-particle sp3" cx="370"  cy="18"  r="1.6" />
  <circle class="stb-particle sp4" cx="550"  cy="105" r="1.8" />
  <circle class="stb-particle sp5" cx="730"  cy="14"  r="1.5" />
  <circle class="stb-particle sp6" cx="900"  cy="106" r="1.7" />
  <circle class="stb-particle sp7" cx="1060" cy="14"  r="1.6" />
  <circle class="stb-particle sp8" cx="1180" cy="100" r="1.5" />
</svg>

<style>
  .settings-banner-svg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
  }

  .stb-track { fill: var(--accent); opacity: 0.10; }
  .stb-fill {
    fill: var(--accent); opacity: 0.28;
    transform-box: fill-box; transform-origin: left;
    animation: stb-fill-grow 0.5s cubic-bezier(0.34, 1.1, 0.64, 1) both;
  }
  .sf1 { animation-delay: 0.10s; }
  .sf2 { animation-delay: 0.22s; }
  .sf3 { animation-delay: 0.34s; }
  .sf4 { animation-delay: 0.18s; }
  .sf5 { animation-delay: 0.30s; }
  @keyframes stb-fill-grow {
    from { transform: scaleX(0); }
    to   { transform: scaleX(1); }
  }

  .stb-knob {
    fill: var(--accent); opacity: 0.55;
    transform-box: fill-box; transform-origin: center;
    animation: stb-knob-pop 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) both;
  }
  .sk1 { animation-delay: 0.15s; }
  .sk2 { animation-delay: 0.27s; }
  .sk3 { animation-delay: 0.39s; }
  .sk4 { animation-delay: 0.23s; }
  .sk5 { animation-delay: 0.35s; }
  @keyframes stb-knob-pop {
    from { transform: scale(0); opacity: 0; }
    to   { transform: scale(1); opacity: 0.55; }
  }

  .stb-toggle-track {
    stroke: var(--accent); stroke-width: 1;
    animation: stb-toggle-appear 0.35s ease both;
  }
  .tt-on  { fill: var(--accent); opacity: 0.22; stroke-opacity: 0.30; }
  .tt-off { fill: var(--accent); opacity: 0.07; stroke-opacity: 0.20; }
  @keyframes stb-toggle-appear {
    from { opacity: 0; }
    to   { opacity: 1; }
  }

  .stb-toggle-knob {
    transform-box: fill-box; transform-origin: center;
    animation: stb-knob-pop 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) both;
  }
  .tk-on  { fill: var(--accent); opacity: 0.65; }
  .tk-off { fill: var(--accent); opacity: 0.30; }
  .stk1 { animation-delay: 0.08s; }
  .stk2 { animation-delay: 0.16s; }
  .stk3 { animation-delay: 0.24s; }
  .stk4 { animation-delay: 0.32s; }
  .stk5 { animation-delay: 0.20s; }

  /* Gear cluster — 4 gears, solid filled silhouettes with a hub hole
     punched out (background-color circle on top of the gear). Each
     gear rotates at a speed proportional to its size; neighbors
     rotate in opposite directions like real meshing gears. */
  .stb-gear {
    fill: var(--accent);
    opacity: 0.18;
    transform-box: fill-box;
    transform-origin: center;
  }
  .stb-gear-hub {
    fill: var(--bg);  /* punches a hub hole through the gear */
  }
  .stb-gear-0 { animation: stb-spin-rev 13s linear infinite; }
  .stb-gear-1 { animation: stb-spin     16s linear infinite; }
  .stb-gear-2 { animation: stb-spin-rev 11s linear infinite; }
  .stb-gear-3 { animation: stb-spin      8s linear infinite; }
  .stb-gear-4 { animation: stb-spin-rev  5s linear infinite; }
  @keyframes stb-spin {
    from { transform: rotate(0deg);   }
    to   { transform: rotate(360deg); }
  }
  @keyframes stb-spin-rev {
    from { transform: rotate(0deg);    }
    to   { transform: rotate(-360deg); }
  }

  .stb-particle {
    fill: var(--accent); opacity: 0.12;
    animation: stb-float 3s ease-in-out infinite;
  }
  .sp1 { animation-delay: 0.0s; animation-duration: 3.0s; }
  .sp2 { animation-delay: 0.4s; animation-duration: 2.8s; }
  .sp3 { animation-delay: 0.8s; animation-duration: 3.4s; }
  .sp4 { animation-delay: 1.2s; animation-duration: 2.6s; }
  .sp5 { animation-delay: 1.6s; animation-duration: 3.2s; }
  .sp6 { animation-delay: 2.0s; animation-duration: 2.9s; }
  .sp7 { animation-delay: 0.6s; animation-duration: 3.3s; }
  .sp8 { animation-delay: 1.0s; animation-duration: 3.0s; }
  @keyframes stb-float {
    0%, 100% { transform: translateY(0);    opacity: 0.12; }
    50%       { transform: translateY(-5px); opacity: 0.22; }
  }

  .settings-banner-svg.no-loop .stb-gear,
  .settings-banner-svg.no-loop .stb-particle {
    animation-iteration-count: 1;
    animation-fill-mode: forwards;
  }

  .settings-banner-svg.no-anim .stb-fill,
  .settings-banner-svg.no-anim .stb-knob,
  .settings-banner-svg.no-anim .stb-toggle-track,
  .settings-banner-svg.no-anim .stb-toggle-knob,
  .settings-banner-svg.no-anim .stb-gear,
  .settings-banner-svg.no-anim .stb-particle {
    animation: none;
    transform: none;
  }
  .settings-banner-svg.no-anim .stb-fill         { opacity: 0.28; }
  .settings-banner-svg.no-anim .stb-knob         { opacity: 0.55; }
  .settings-banner-svg.no-anim .stb-toggle-track { opacity: 1; }
  .settings-banner-svg.no-anim .stb-toggle-knob  { opacity: 1; }
  .settings-banner-svg.no-anim .stb-particle     { opacity: 0.12; }

  @media (prefers-reduced-motion: reduce) {
    .stb-fill, .stb-knob, .stb-toggle-track, .stb-toggle-knob, .stb-gear, .stb-particle {
      animation: none !important;
      transform: none !important;
    }
  }
</style>
