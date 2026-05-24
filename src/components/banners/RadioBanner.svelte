<script>
  import { onMount, onDestroy } from 'svelte';
  import { disableAnimations } from '../../stores/settings.js';

  $: noAnim = $disableAnimations;

  const BARS = 64;
  const SEGS = 12;
  const SEG_H = 5;
  const SEG_GAP = 1.8;
  const BAR_W = 10;
  const BAR_GAP = 4;
  const totalW = BARS * (BAR_W + BAR_GAP) - BAR_GAP;
  const startX = (1200 - totalW) / 2;
  const BASE_Y = 110;

  let levels = Array(BARS).fill(0);
  let targets = Array(BARS).fill(0);
  let interval;
  let frameId;

  function newTargets() {
    targets = targets.map((_, i) => {
      const center = BARS / 2;
      const dist = Math.abs(i - center) / center;
      const base = Math.round((1 - dist * 0.5) * SEGS * 0.7);
      const variation = Math.floor(Math.random() * 6) - 2;
      return Math.max(1, Math.min(SEGS, base + variation));
    });
  }

  function tick() {
    levels = levels.map((lvl, i) => {
      const t = targets[i];
      if (lvl < t) return lvl + 1;
      if (lvl > t) return lvl - 1;
      return lvl;
    });
  }

  onMount(() => {
    if (noAnim) {
      newTargets();
      levels = [...targets];
      return;
    }
    newTargets();
    interval = setInterval(newTargets, 400);
    function animate() {
      tick();
      frameId = setTimeout(animate, 80);
    }
    animate();
  });

  onDestroy(() => {
    clearInterval(interval);
    clearTimeout(frameId);
  });

  const barGeometry = Array.from({ length: BARS }, (_, bi) => {
    const x = startX + bi * (BAR_W + BAR_GAP);
    return Array.from({ length: SEGS }, (_, si) => ({
      x,
      y: BASE_Y - si * (SEG_H + SEG_GAP) - SEG_H,
      // Color zone: bottom=green(accent), mid=yellow, top=red/hot
      zone: si < 5 ? 'low' : si < 9 ? 'mid' : 'high',
    }));
  });

  // Music notes scattered across the full 1200-wide viewBox for ambient flair.
  const NOTES = [
    { char: '♪', x: 60,   y: 28, delay: '0s',   dur: '4.2s', dx: -8 },
    { char: '♫', x: 140,  y: 70, delay: '1.2s', dur: '3.6s', dx: 6  },
    { char: '♩', x: 240,  y: 18, delay: '2.5s', dur: '4.8s', dx: -5 },
    { char: '♪', x: 360,  y: 95, delay: '0.8s', dur: '3.9s', dx: 7  },
    { char: '♫', x: 880,  y: 24, delay: '2.0s', dur: '4.4s', dx: -6 },
    { char: '♩', x: 980,  y: 92, delay: '3.2s', dur: '3.5s', dx: 8  },
    { char: '♪', x: 1080, y: 30, delay: '1.5s', dur: '4.0s', dx: -7 },
    { char: '♫', x: 1160, y: 88, delay: '0.4s', dur: '3.8s', dx: 5  },
  ];
</script>

<svg class="radio-banner-svg" class:no-anim={noAnim}
  viewBox="0 0 1200 120" preserveAspectRatio="xMidYMid slice"
  xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs>
    <radialGradient id="ltrb-glow" cx="50%" cy="50%" r="42%" gradientUnits="objectBoundingBox">
      <stop offset="0%"   stop-color="var(--accent)" stop-opacity="0.18" />
      <stop offset="100%" stop-color="var(--accent)" stop-opacity="0" />
    </radialGradient>
  </defs>
  <rect x="0" y="0" width="1200" height="120" fill="url(#ltrb-glow)" />

  <!-- EQ bars span the full 1200 width — 64 bars now. -->
  {#each barGeometry as segs, bi}
    {#each segs as seg, si}
      <rect
        x={seg.x} y={seg.y} width={BAR_W} height={SEG_H}
        rx="1.5"
        class="eq-seg {seg.zone}"
        class:lit={si < levels[bi]}
      />
    {/each}
  {/each}

  <!-- Floating music notes scattered across the width -->
  {#each NOTES as note}
    <text
      class="music-note"
      x={note.x} y={note.y}
      style="animation-delay:{note.delay};animation-duration:{note.dur};--dx:{note.dx}px"
    >{note.char}</text>
  {/each}
</svg>

<style>
  .radio-banner-svg {
    position: absolute; inset: 0;
    width: 100%; height: 100%;
    pointer-events: none;
  }

  /* EQ segments — 3 color zones */
  .eq-seg {
    transition: fill-opacity 0.08s linear;
  }
  .eq-seg.low {
    fill: var(--accent);
    fill-opacity: 0.04;
  }
  .eq-seg.low.lit {
    fill: var(--accent);
    fill-opacity: 0.40;
  }
  .eq-seg.mid {
    fill: var(--warning, #FFB547);
    fill-opacity: 0.04;
  }
  .eq-seg.mid.lit {
    fill: var(--warning, #FFB547);
    fill-opacity: 0.38;
  }
  .eq-seg.high {
    fill: var(--danger, #FF5C5C);
    fill-opacity: 0.04;
  }
  .eq-seg.high.lit {
    fill: var(--danger, #FF5C5C);
    fill-opacity: 0.35;
  }

  /* Floating music notes */
  .music-note {
    font-size: 18px;
    fill: var(--accent);
    opacity: 0.20;
    animation: note-float 4s ease-in-out infinite;
  }
  @keyframes note-float {
    0%, 100% {
      transform: translate(0, 0);
      opacity: 0.15;
    }
    50% {
      transform: translate(var(--dx, 0), -12px);
      opacity: 0.35;
    }
  }

  .radio-banner-svg.no-anim .music-note { animation: none; opacity: 0.2; }
  @media (prefers-reduced-motion: reduce) {
    .music-note { animation: none !important; opacity: 0.2 !important; }
  }
</style>
