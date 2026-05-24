<script>
  import { disableAnimations, loopBannerAnimations } from '../../stores/settings.js';
  $: noAnim = $disableAnimations;
  $: noLoop = !$loopBannerAnimations;
</script>

<!--
  Exercises banner — loaded barbell hero with a tight 3-piece dumbbell
  rack positioned between bar and kettlebell on each side, kettlebells
  at the far edges.

  Composition center-out:
    KB   (gap)   [small + medium + large DB rack]   BARBELL   [large + medium + small DB rack]   (gap)   KB

  All plates and dumbbells use SAME brightness — no dimming filter, so
  the outer plates don't look translucent on the dark background.
  Plates stacked edge-to-edge with no gap between them so the sleeve
  never peeks through.
-->
<!-- ──────────────────────────────────────────────────────────────────
     MOBILE banner — HERO ONLY. The loaded barbell IS the banner.
     A kettlebell sits at each far edge as a supporting flourish.
     No dumbbell rack on mobile — keep the hero prominent, don't
     cram supporting elements in.
─────────────────────────────────────────────────────────────────── -->
<svg
  class="ex-banner-svg ex-banner-mobile"
  class:no-anim={noAnim}
  class:no-loop={noLoop}
  viewBox="0 0 500 120"
  preserveAspectRatio="xMidYMid slice"
  xmlns="http://www.w3.org/2000/svg"
  aria-hidden="true"
>
  <defs>
    <radialGradient id="ltex-glow-m" cx="50%" cy="50%" r="55%" gradientUnits="objectBoundingBox">
      <stop offset="0%"   stop-color="var(--accent)" stop-opacity="0.16" />
      <stop offset="100%" stop-color="var(--accent)" stop-opacity="0" />
    </radialGradient>
  </defs>
  <rect x="0" y="0" width="500" height="120" fill="url(#ltex-glow-m)" />

  <!-- Mobile KB LEFT (x=35) -->
  <g transform="translate(35, 50)">
    <g class="ltex-kettlebell">
      <circle class="ltex-kb-part" cx="0" cy="14" r="15" />
      <rect class="ltex-kb-part" x="-8" y="-3" width="16" height="6" rx="2" />
      <path class="ltex-kb-part" fill-rule="evenodd"
        d="M -10 -22 Q -13 -22 -13 -19
           L -13 -7  Q -13 -3  -9 -3
           L 9 -3    Q 13 -3   13 -7
           L 13 -19  Q 13 -22  10 -22 Z
           M -6 -18  Q -8 -18  -8 -16
           L -8 -10  Q -8 -8   -6 -8
           L 6 -8    Q 8 -8    8 -10
           L 8 -16   Q 8 -18   6 -18 Z" />
    </g>
  </g>

  <!-- Mobile HERO BARBELL — bigger than desktop, centered. Bar+plates
       span x=110..390 (280 wide), the dominant feature of the banner. -->
  <g class="ltex-barbell" transform="translate(250, 60)">
    <rect class="ltex-bar"    x="-90"  y="-3" width="180" height="6" rx="3" />
    <rect class="ltex-sleeve" x="-128" y="-5" width="38"  height="10" rx="2" />
    <rect class="ltex-sleeve" x="90"   y="-5" width="38"  height="10" rx="2" />
    <!-- Plates LEFT — 45 innermost, edge-to-edge -->
    <rect class="ltex-plate p45" x="-102" y="-32" width="12" height="64" rx="2.5" />
    <rect class="ltex-plate p35" x="-114" y="-26" width="12" height="52" rx="2.5" />
    <rect class="ltex-plate p25" x="-124" y="-20" width="10" height="40" rx="2"   />
    <rect class="ltex-plate p10" x="-130" y="-15" width="6"  height="30" rx="2"   />
    <rect class="ltex-clip" x="-134" y="-9" width="4" height="18" rx="1" />
    <rect class="ltex-cap"  x="-138" y="-5" width="4" height="10" rx="1" />
    <!-- Plates RIGHT — mirror -->
    <rect class="ltex-plate p45" x="90"  y="-32" width="12" height="64" rx="2.5" />
    <rect class="ltex-plate p35" x="102" y="-26" width="12" height="52" rx="2.5" />
    <rect class="ltex-plate p25" x="114" y="-20" width="10" height="40" rx="2"   />
    <rect class="ltex-plate p10" x="124" y="-15" width="6"  height="30" rx="2"   />
    <rect class="ltex-clip" x="130" y="-9" width="4" height="18" rx="1" />
    <rect class="ltex-cap"  x="134" y="-5" width="4" height="10" rx="1" />
  </g>

  <!-- Mobile KB RIGHT (x=465) -->
  <g transform="translate(465, 50)">
    <g class="ltex-kettlebell ltex-kb-right">
      <circle class="ltex-kb-part" cx="0" cy="14" r="15" />
      <rect class="ltex-kb-part" x="-8" y="-3" width="16" height="6" rx="2" />
      <path class="ltex-kb-part" fill-rule="evenodd"
        d="M -10 -22 Q -13 -22 -13 -19
           L -13 -7  Q -13 -3  -9 -3
           L 9 -3    Q 13 -3   13 -7
           L 13 -19  Q 13 -22  10 -22 Z
           M -6 -18  Q -8 -18  -8 -16
           L -8 -10  Q -8 -8   -6 -8
           L 6 -8    Q 8 -8    8 -10
           L 8 -16   Q 8 -18   6 -18 Z" />
    </g>
  </g>

  <!-- Mobile particles (fewer, just for atmosphere) -->
  <circle class="ltex-dot d1" cx="80"  cy="20"  r="1.5" />
  <circle class="ltex-dot d2" cx="170" cy="100" r="1.4" />
  <circle class="ltex-dot d3" cx="330" cy="14"  r="1.5" />
  <circle class="ltex-dot d4" cx="420" cy="100" r="1.4" />
</svg>

<!-- ──────────────────────────────────────────────────────────────────
     DESKTOP banner (viewBox 1200x120, aspect 10:1). Full spread:
     KB ← small DB ← med DB ← large DB ← BARBELL → large DB → med DB
     → small DB → KB. Shown at >=768px.
─────────────────────────────────────────────────────────────────── -->
<svg
  class="ex-banner-svg ex-banner-desktop"
  class:no-anim={noAnim}
  class:no-loop={noLoop}
  viewBox="0 0 1200 120"
  preserveAspectRatio="xMidYMid slice"
  xmlns="http://www.w3.org/2000/svg"
  aria-hidden="true"
>
  <defs>
    <radialGradient id="ltex-glow" cx="50%" cy="50%" r="55%" gradientUnits="objectBoundingBox">
      <stop offset="0%"   stop-color="var(--accent)" stop-opacity="0.16" />
      <stop offset="100%" stop-color="var(--accent)" stop-opacity="0" />
    </radialGradient>
  </defs>

  <rect x="0" y="0" width="1200" height="120" fill="url(#ltex-glow)" />

  <!-- ── KETTLEBELL — far LEFT edge (x=130). Real kettlebell shape:
       solid chunky handle frame (with rectangular hole), narrow neck,
       round bell sphere. ────────────────────────────────────────── -->
  <g transform="translate(130, 50)">
    <g class="ltex-kettlebell">
      <!-- Bell — round sphere body -->
      <circle class="ltex-kb-part" cx="0" cy="14" r="15" />
      <!-- Neck — narrow bridge between handle bottom and bell top -->
      <rect class="ltex-kb-part" x="-8" y="-3" width="16" height="6" rx="2" />
      <!-- Handle frame (rounded rectangle outer + rounded rectangle hole,
           evenodd fill rule cuts out the inner so the handle reads as a
           thick frame you'd grip). -->
      <path class="ltex-kb-part"
        fill-rule="evenodd"
        d="M -10 -22 Q -13 -22 -13 -19
           L -13 -7  Q -13 -3  -9 -3
           L 9 -3    Q 13 -3   13 -7
           L 13 -19  Q 13 -22  10 -22 Z
           M -6 -18  Q -8 -18  -8 -16
           L -8 -10  Q -8 -8   -6 -8
           L 6 -8    Q 8 -8    8 -10
           L 8 -16   Q 8 -18   6 -18 Z" />
    </g>
  </g>

  <!-- ── LEFT DUMBBELL RACK — tight 3-piece, centered midway between KB and bar ── -->
  <!-- Centers: small=268, medium=306, large=344 (38 apart) -->
  <line class="ltex-floor" x1="240" y1="106" x2="370" y2="106" />

  <!-- Small dumbbell (outermost, near KB) -->
  <g class="ltex-dumbbell" transform="translate(268, 86)">
    <rect class="ltex-db-bell" x="-12" y="-9"  width="8"  height="18" rx="2" />
    <rect class="ltex-db-bell" x="4"   y="-9"  width="8"  height="18" rx="2" />
    <rect class="ltex-db-bar"  x="-4"  y="-2"  width="8"  height="4" rx="1.5" />
  </g>
  <!-- Medium dumbbell -->
  <g class="ltex-dumbbell" transform="translate(306, 84)">
    <rect class="ltex-db-bell" x="-16" y="-11" width="11" height="22" rx="2.5" />
    <rect class="ltex-db-bell" x="5"   y="-11" width="11" height="22" rx="2.5" />
    <rect class="ltex-db-bar"  x="-5"  y="-2.5" width="10" height="5" rx="2" />
  </g>
  <!-- Large dumbbell (innermost, near bar) -->
  <g class="ltex-dumbbell" transform="translate(344, 82)">
    <rect class="ltex-db-bell" x="-20" y="-13" width="14" height="26" rx="3" />
    <rect class="ltex-db-bell" x="6"   y="-13" width="14" height="26" rx="3" />
    <rect class="ltex-db-bar"  x="-6"  y="-3"  width="12" height="6" rx="2" />
  </g>

  <!-- ── HERO BARBELL — center, bar+plates span x=462..738 ─────────── -->
  <g class="ltex-barbell" transform="translate(600, 60)">
    <!-- Bar shaft (thin grip area) -->
    <rect class="ltex-bar"    x="-90"  y="-3" width="180" height="6" rx="3" />
    <!-- Inner sleeves (slightly thicker plate-loading area) -->
    <rect class="ltex-sleeve" x="-128" y="-5" width="38"  height="10" rx="2" />
    <rect class="ltex-sleeve" x="90"   y="-5" width="38"  height="10" rx="2" />

    <!-- Plates LEFT — edge-to-edge, NO gap so the sleeve never shows.
         45 innermost against shaft, then 35, 25, 10 going outward. -->
    <rect class="ltex-plate p45" x="-102" y="-32" width="12" height="64" rx="2.5" />
    <rect class="ltex-plate p35" x="-114" y="-26" width="12" height="52" rx="2.5" />
    <rect class="ltex-plate p25" x="-124" y="-20" width="10" height="40" rx="2"   />
    <rect class="ltex-plate p10" x="-130" y="-15" width="6"  height="30" rx="2"   />
    <rect class="ltex-clip" x="-134" y="-9" width="4" height="18" rx="1" />
    <rect class="ltex-cap"  x="-138" y="-5" width="4" height="10" rx="1" />

    <!-- Plates RIGHT — mirror -->
    <rect class="ltex-plate p45" x="90"  y="-32" width="12" height="64" rx="2.5" />
    <rect class="ltex-plate p35" x="102" y="-26" width="12" height="52" rx="2.5" />
    <rect class="ltex-plate p25" x="114" y="-20" width="10" height="40" rx="2"   />
    <rect class="ltex-plate p10" x="124" y="-15" width="6"  height="30" rx="2"   />
    <rect class="ltex-clip" x="130" y="-9" width="4" height="18" rx="1" />
    <rect class="ltex-cap"  x="134" y="-5" width="4" height="10" rx="1" />
  </g>

  <!-- ── RIGHT DUMBBELL RACK — mirror, centers 856 / 894 / 932 ─────── -->
  <line class="ltex-floor" x1="830" y1="106" x2="960" y2="106" />
  <g class="ltex-dumbbell" transform="translate(856, 82)">
    <rect class="ltex-db-bell" x="-20" y="-13" width="14" height="26" rx="3" />
    <rect class="ltex-db-bell" x="6"   y="-13" width="14" height="26" rx="3" />
    <rect class="ltex-db-bar"  x="-6"  y="-3"  width="12" height="6" rx="2" />
  </g>
  <g class="ltex-dumbbell" transform="translate(894, 84)">
    <rect class="ltex-db-bell" x="-16" y="-11" width="11" height="22" rx="2.5" />
    <rect class="ltex-db-bell" x="5"   y="-11" width="11" height="22" rx="2.5" />
    <rect class="ltex-db-bar"  x="-5"  y="-2.5" width="10" height="5" rx="2" />
  </g>
  <g class="ltex-dumbbell" transform="translate(932, 86)">
    <rect class="ltex-db-bell" x="-12" y="-9"  width="8"  height="18" rx="2" />
    <rect class="ltex-db-bell" x="4"   y="-9"  width="8"  height="18" rx="2" />
    <rect class="ltex-db-bar"  x="-4"  y="-2"  width="8"  height="4" rx="1.5" />
  </g>

  <!-- ── KETTLEBELL — far RIGHT edge (x=1070) ──────────────────── -->
  <g transform="translate(1070, 50)">
    <g class="ltex-kettlebell ltex-kb-right">
      <circle class="ltex-kb-part" cx="0" cy="14" r="15" />
      <rect class="ltex-kb-part" x="-8" y="-3" width="16" height="6" rx="2" />
      <path class="ltex-kb-part"
        fill-rule="evenodd"
        d="M -10 -22 Q -13 -22 -13 -19
           L -13 -7  Q -13 -3  -9 -3
           L 9 -3    Q 13 -3   13 -7
           L 13 -19  Q 13 -22  10 -22 Z
           M -6 -18  Q -8 -18  -8 -16
           L -8 -10  Q -8 -8   -6 -8
           L 6 -8    Q 8 -8    8 -10
           L 8 -16   Q 8 -18   6 -18 Z" />
    </g>
  </g>

  <!-- Floating particles -->
  <circle class="ltex-dot d1" cx="60"   cy="30"  r="1.7" />
  <circle class="ltex-dot d2" cx="200"  cy="20"  r="1.5" />
  <circle class="ltex-dot d3" cx="420"  cy="100" r="1.6" />
  <circle class="ltex-dot d4" cx="500"  cy="14"  r="1.5" />
  <circle class="ltex-dot d5" cx="700"  cy="18"  r="1.7" />
  <circle class="ltex-dot d6" cx="780"  cy="100" r="1.5" />
  <circle class="ltex-dot d7" cx="1000" cy="30"  r="1.6" />
  <circle class="ltex-dot d8" cx="1180" cy="20"  r="1.5" />
</svg>

<style>
  .ex-banner-svg {
    position: absolute; inset: 0;
    width: 100%; height: 100%;
    pointer-events: none;
  }

  /* Mobile/desktop variant swap. Phone-sized headers get the compact
     5-piece banner; tablet+ gets the wide 9-piece composition. */
  @media (max-width: 767px) {
    .ex-banner-desktop { display: none; }
  }
  @media (min-width: 768px) {
    .ex-banner-mobile { display: none; }
  }

  .ltex-floor {
    stroke: var(--accent);
    stroke-opacity: 0.18;
    stroke-width: 1;
  }

  /* Barbell — solid accent. */
  .ltex-bar    { fill: var(--accent); opacity: 0.9;  }
  .ltex-sleeve { fill: var(--accent); opacity: 0.75; }
  .ltex-cap    { fill: var(--accent); opacity: 0.85; }
  .ltex-clip   { fill: var(--accent); opacity: 0.7;  }

  /* Plates — ALL fully opaque, ALL full brightness (no dimming filter
     on outer plates — that's what made them look translucent on a dark
     background). Size differentiation is purely from the rect heights. */
  .ltex-plate {
    fill: var(--accent);
    opacity: 1;
    transform-box: fill-box;
    transform-origin: center;
    animation: ltex-pulse 4s ease-in-out infinite;
  }
  .p45 { animation-delay: 0.00s; }
  .p35 { animation-delay: 0.15s; }
  .p25 { animation-delay: 0.30s; }
  .p10 { animation-delay: 0.45s; }
  @keyframes ltex-pulse {
    0%, 100% { filter: brightness(1);    }
    50%      { filter: brightness(1.15); }
  }

  /* Dumbbells — all same full-brightness fill. */
  .ltex-db-bell { fill: var(--accent); opacity: 0.95; }
  .ltex-db-bar  { fill: var(--accent); opacity: 0.7;  }

  /* Kettlebell parts — bell circle, neck rect, handle frame all SOLID
     filled with the accent color. No stroked handle (that's what made
     the previous version look like a saddle bag). */
  .ltex-kb-part { fill: var(--accent); opacity: 0.95; }
  .ltex-kettlebell {
    transform-box: fill-box;
    transform-origin: center top;
    animation: ltex-sway 4.5s ease-in-out infinite;
  }
  .ltex-kb-right { animation-delay: -2.25s; }
  @keyframes ltex-sway {
    0%, 100% { transform: rotate(-3deg); }
    50%      { transform: rotate(3deg);  }
  }

  /* Particles */
  .ltex-dot {
    fill: var(--accent);
    opacity: 0.18;
    animation: ltex-float 3s ease-in-out infinite;
  }
  .d1 { animation-delay: 0.0s; animation-duration: 3.2s; }
  .d2 { animation-delay: 0.4s; animation-duration: 2.8s; }
  .d3 { animation-delay: 0.8s; animation-duration: 3.4s; }
  .d4 { animation-delay: 1.2s; animation-duration: 2.6s; }
  .d5 { animation-delay: 1.6s; animation-duration: 3.0s; }
  .d6 { animation-delay: 0.2s; animation-duration: 3.3s; }
  .d7 { animation-delay: 0.6s; animation-duration: 2.9s; }
  .d8 { animation-delay: 1.0s; animation-duration: 3.1s; }
  @keyframes ltex-float {
    0%, 100% { transform: translateY(0);    opacity: 0.18; }
    50%       { transform: translateY(-4px); opacity: 0.32; }
  }

  .ex-banner-svg.no-loop .ltex-plate,
  .ex-banner-svg.no-loop .ltex-kettlebell,
  .ex-banner-svg.no-loop .ltex-dot {
    animation-iteration-count: 1;
    animation-fill-mode: forwards;
  }

  .ex-banner-svg.no-anim .ltex-plate,
  .ex-banner-svg.no-anim .ltex-kettlebell,
  .ex-banner-svg.no-anim .ltex-dot {
    animation: none;
    transform: none;
    filter: none;
  }

  @media (prefers-reduced-motion: reduce) {
    .ltex-plate, .ltex-kettlebell, .ltex-dot {
      animation: none !important;
      transform: none !important;
      filter: none !important;
    }
  }
</style>
