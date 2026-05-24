<script>
  import { disableAnimations, loopBannerAnimations } from '../../stores/settings.js';
  $: noAnim = $disableAnimations;
  $: noLoop = !$loopBannerAnimations;
</script>

<!--
  Statistics page banner — animated chart illustration. viewBox is
  1200x120 so the content fills the page-header at every width;
  preserveAspectRatio="slice" crops the sides on narrow phones
  (the center 6-8 bars stay visible) and shows the full 16-bar span
  on desktop. Mirrors NutriTrace's StatsBanner visual language.
-->
<svg
  class="stats-banner-svg"
  class:no-anim={noAnim}
  class:no-loop={noLoop}
  viewBox="0 0 1200 120"
  preserveAspectRatio="xMidYMid slice"
  xmlns="http://www.w3.org/2000/svg"
  aria-hidden="true"
>
  <defs>
    <radialGradient id="sb-glow" cx="50%" cy="20%" r="60%" gradientUnits="objectBoundingBox">
      <stop offset="0%"   stop-color="var(--accent)" stop-opacity="0.18" />
      <stop offset="100%" stop-color="var(--accent)" stop-opacity="0"    />
    </radialGradient>
    <linearGradient id="sb-bar-grad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stop-color="var(--accent)" stop-opacity="0.26" />
      <stop offset="100%" stop-color="var(--accent)" stop-opacity="0.06" />
    </linearGradient>
  </defs>

  <rect x="0" y="0" width="1200" height="120" fill="url(#sb-glow)" />

  <g class="sb-grid">
    <line x1="0" y1="30" x2="1200" y2="30" />
    <line x1="0" y1="60" x2="1200" y2="60" />
    <line x1="0" y1="90" x2="1200" y2="90" />
  </g>

  <!-- 16 bars across the full 1200 width — even spacing 75 each, bar width 56 -->
  <g class="sb-bars">
    <rect class="sb-bar  b1"  x="10"   y="92" width="56" height="28" rx="3" fill="url(#sb-bar-grad)" />
    <rect class="sb-bar  b2"  x="85"   y="78" width="56" height="42" rx="3" fill="url(#sb-bar-grad)" />
    <rect class="sb-bar  b3"  x="160"  y="62" width="56" height="58" rx="3" fill="url(#sb-bar-grad)" />
    <rect class="sb-bar  b4"  x="235"  y="80" width="56" height="40" rx="3" fill="url(#sb-bar-grad)" />
    <rect class="sb-bar  b5"  x="310"  y="50" width="56" height="70" rx="3" fill="url(#sb-bar-grad)" />
    <rect class="sb-bar  b6"  x="385"  y="42" width="56" height="78" rx="3" fill="url(#sb-bar-grad)" />
    <rect class="sb-bar  b7"  x="460"  y="32" width="56" height="88" rx="3" fill="url(#sb-bar-grad)" />
    <rect class="sb-bar  b8"  x="535"  y="55" width="56" height="65" rx="3" fill="url(#sb-bar-grad)" />
    <rect class="sb-bar  b9"  x="610"  y="22" width="56" height="98" rx="3" fill="url(#sb-bar-grad)" />
    <rect class="sb-bar  b10" x="685"  y="37" width="56" height="83" rx="3" fill="url(#sb-bar-grad)" />
    <rect class="sb-bar  b11" x="760"  y="48" width="56" height="72" rx="3" fill="url(#sb-bar-grad)" />
    <rect class="sb-bar  b12" x="835"  y="28" width="56" height="92" rx="3" fill="url(#sb-bar-grad)" />
    <rect class="sb-bar  b13" x="910"  y="50" width="56" height="70" rx="3" fill="url(#sb-bar-grad)" />
    <rect class="sb-bar  b14" x="985"  y="38" width="56" height="82" rx="3" fill="url(#sb-bar-grad)" />
    <rect class="sb-bar  b15" x="1060" y="60" width="56" height="60" rx="3" fill="url(#sb-bar-grad)" />
    <rect class="sb-bar  b16" x="1135" y="50" width="56" height="70" rx="3" fill="url(#sb-bar-grad)" />
  </g>

  <!-- Trend line through each bar top — smooth cubic bezier -->
  <path
    class="sb-line"
    d="M 38,92  C 60,86 92,78 113,78
       C 134,78 163,66 188,62
       C 213,58 240,78 263,80
       C 286,82 309,55 338,50
       C 367,45 388,42 413,42
       C 438,42 459,33 488,32
       C 517,31 538,55 563,55
       C 588,55 615,22 638,22
       C 661,22 688,37 713,37
       C 738,37 763,48 788,48
       C 813,48 838,28 863,28
       C 888,28 913,50 938,50
       C 963,50 988,38 1013,38
       C 1038,38 1063,60 1088,60
       C 1113,60 1138,50 1163,50"
    fill="none"
  />

  <!-- Dots on every bar top -->
  <g class="sb-dots">
    <circle class="sb-dot d1"  cx="38"   cy="92" r="4" />
    <circle class="sb-dot d2"  cx="113"  cy="78" r="4" />
    <circle class="sb-dot d3"  cx="188"  cy="62" r="4" />
    <circle class="sb-dot d4"  cx="263"  cy="80" r="4" />
    <circle class="sb-dot d5"  cx="338"  cy="50" r="4" />
    <circle class="sb-dot d6"  cx="413"  cy="42" r="4" />
    <circle class="sb-dot d7"  cx="488"  cy="32" r="4" />
    <circle class="sb-dot d8"  cx="563"  cy="55" r="4" />
    <circle class="sb-dot d9"  cx="638"  cy="22" r="4" />
    <circle class="sb-dot d10" cx="713"  cy="37" r="4" />
    <circle class="sb-dot d11" cx="788"  cy="48" r="4" />
    <circle class="sb-dot d12" cx="863"  cy="28" r="4" />
    <circle class="sb-dot d13" cx="938"  cy="50" r="4" />
    <circle class="sb-dot d14" cx="1013" cy="38" r="4" />
    <circle class="sb-dot d15" cx="1088" cy="60" r="4" />
    <circle class="sb-dot d16" cx="1163" cy="50" r="4" />
  </g>

  <!-- Floating particles scattered across the full width -->
  <g class="sb-particles">
    <circle class="sb-particle p1" cx="80"   cy="26" r="2"   />
    <circle class="sb-particle p2" cx="240"  cy="14" r="1.5" />
    <circle class="sb-particle p3" cx="400"  cy="20" r="1.7" />
    <circle class="sb-particle p4" cx="560"  cy="12" r="1.5" />
    <circle class="sb-particle p5" cx="720"  cy="16" r="2"   />
    <circle class="sb-particle p6" cx="880"  cy="10" r="1.5" />
    <circle class="sb-particle p7" cx="1020" cy="22" r="1.8" />
    <circle class="sb-particle p8" cx="1160" cy="14" r="1.5" />
  </g>
</svg>

<style>
  .stats-banner-svg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
  }

  .sb-grid line {
    stroke: var(--accent);
    stroke-width: 0.5;
    opacity: 0.07;
  }

  .sb-bar {
    transform-box: fill-box;
    transform-origin: bottom;
    animation: sb-bar-rise 0.55s cubic-bezier(0.34, 1.2, 0.64, 1) both;
  }
  .b1  { animation-delay: 0.00s; }
  .b2  { animation-delay: 0.03s; }
  .b3  { animation-delay: 0.06s; }
  .b4  { animation-delay: 0.09s; }
  .b5  { animation-delay: 0.12s; }
  .b6  { animation-delay: 0.15s; }
  .b7  { animation-delay: 0.18s; }
  .b8  { animation-delay: 0.21s; }
  .b9  { animation-delay: 0.24s; }
  .b10 { animation-delay: 0.27s; }
  .b11 { animation-delay: 0.30s; }
  .b12 { animation-delay: 0.33s; }
  .b13 { animation-delay: 0.36s; }
  .b14 { animation-delay: 0.39s; }
  .b15 { animation-delay: 0.42s; }
  .b16 { animation-delay: 0.45s; }
  @keyframes sb-bar-rise {
    from { transform: scaleY(0); }
    to   { transform: scaleY(1); }
  }

  .sb-line {
    stroke: var(--accent);
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
    opacity: 0.5;
    stroke-dasharray: 3000;
    stroke-dashoffset: 3000;
    animation: sb-line-draw 1.4s cubic-bezier(0.4, 0, 0.2, 1) 0.45s both;
  }
  @keyframes sb-line-draw {
    to { stroke-dashoffset: 0; }
  }

  .sb-dot {
    fill: var(--accent);
    opacity: 0.65;
    transform-box: fill-box;
    transform-origin: center;
    animation: sb-dot-pop 0.35s cubic-bezier(0.34, 1.56, 0.64, 1) both;
  }
  .d1  { animation-delay: 0.82s; }
  .d2  { animation-delay: 0.87s; }
  .d3  { animation-delay: 0.92s; }
  .d4  { animation-delay: 0.97s; }
  .d5  { animation-delay: 1.02s; }
  .d6  { animation-delay: 1.07s; }
  .d7  { animation-delay: 1.12s; }
  .d8  { animation-delay: 1.17s; }
  .d9  { animation-delay: 1.22s; }
  .d10 { animation-delay: 1.27s; }
  .d11 { animation-delay: 1.32s; }
  .d12 { animation-delay: 1.37s; }
  .d13 { animation-delay: 1.42s; }
  .d14 { animation-delay: 1.47s; }
  .d15 { animation-delay: 1.52s; }
  .d16 { animation-delay: 1.57s; }
  @keyframes sb-dot-pop {
    from { transform: scale(0); }
    to   { transform: scale(1); }
  }

  .sb-particle {
    fill: var(--accent);
    opacity: 0.12;
    animation: sb-float 3s ease-in-out infinite;
  }
  .p1 { animation-delay: 0.0s; animation-duration: 3.2s; }
  .p2 { animation-delay: 0.4s; animation-duration: 2.8s; }
  .p3 { animation-delay: 0.8s; animation-duration: 3.5s; }
  .p4 { animation-delay: 1.2s; animation-duration: 3.0s; }
  .p5 { animation-delay: 1.6s; animation-duration: 2.6s; }
  .p6 { animation-delay: 2.0s; animation-duration: 3.3s; }
  .p7 { animation-delay: 2.4s; animation-duration: 2.9s; }
  .p8 { animation-delay: 0.6s; animation-duration: 3.4s; }
  @keyframes sb-float {
    0%, 100% { transform: translateY(0px);  }
    50%       { transform: translateY(-5px); }
  }

  .stats-banner-svg.no-loop .sb-particle {
    animation-iteration-count: 1;
    animation-fill-mode: forwards;
  }

  .stats-banner-svg.no-anim .sb-bar,
  .stats-banner-svg.no-anim .sb-line,
  .stats-banner-svg.no-anim .sb-dot,
  .stats-banner-svg.no-anim .sb-particle {
    animation: none;
    stroke-dashoffset: 0;
    transform: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .sb-bar, .sb-line, .sb-dot, .sb-particle {
      animation: none !important;
      stroke-dashoffset: 0 !important;
    }
  }
</style>
