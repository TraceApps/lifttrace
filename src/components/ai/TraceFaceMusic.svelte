<!--
  TraceFaceMusic — LiftTrace-only flourish that wraps the shared
  TraceFace mascot with over-ear headphones, shown while music is
  playing. The TraceFace SVG itself stays untouched (mirrored across
  CookTrace / NutriTrace / LiftTrace per the brand-cohesion rule).

  This component ALWAYS renders TraceFace. The headphones layer is
  always in the DOM too, but it CSS-transitions in/out based on the
  `playing` prop — they drop down onto the head with a small overshoot
  when music starts and slide back up off the head when it stops, so
  the change feels animated rather than a hard cut.

  The two earcups pulse on a 1.1s ease-in-out cycle (slightly stronger
  than the antenna pulse so it reads as "active" without dominating
  the face), with a paired opacity animation on the inner light so
  the pulse glows rather than just jiggling in size.

  Used by Trace.svelte: `<TraceFaceMusic size={N} playing={$isPlaying && $currentTrack != null} />`
-->
<script>
  import TraceFace from './TraceFace.svelte';
  export let size = 42;
  export let playing = false;
</script>

<div class="trace-face-music" style="width:{size}px;height:{size}px">
  <TraceFace {size} />
  <svg class="music-headphones" class:playing viewBox="0 0 56 56"
    xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <!-- Headband — slim arc bridging the two earcups, drawn under the
         cups so they sit on top of its endpoints. -->
    <path class="hp-band"
      d="M10 30 Q10 12 28 12 Q46 12 46 30"
      fill="none" stroke="#1f2742" stroke-width="2.6" stroke-linecap="round"/>
    <path class="hp-band-hl"
      d="M10 30 Q10 12 28 12 Q46 12 46 30"
      fill="none" stroke="#ffffff" stroke-width="0.6" stroke-linecap="round" opacity="0.35"/>

    <!-- Left earcup -->
    <g class="hp-cup hp-cup-l">
      <rect x="6" y="24" width="8" height="12" rx="3" ry="3"
        fill="#1f2742" stroke="#0a0d18" stroke-width="0.6"/>
      <circle class="hp-light" cx="10" cy="30" r="2" fill="currentColor"/>
    </g>

    <!-- Right earcup -->
    <g class="hp-cup hp-cup-r">
      <rect x="42" y="24" width="8" height="12" rx="3" ry="3"
        fill="#1f2742" stroke="#0a0d18" stroke-width="0.6"/>
      <circle class="hp-light" cx="46" cy="30" r="2" fill="currentColor"/>
    </g>
  </svg>
</div>

<style>
  .trace-face-music {
    position: relative;
    display: inline-flex;
    flex-shrink: 0;
  }
  /* Default state — headphones hover above the head, invisible.
     Pointer-events none so the off-state doesn't intercept taps. */
  .music-headphones {
    position: absolute;
    inset: 0;
    width: 100%; height: 100%;
    pointer-events: none;
    filter: drop-shadow(0 1.2px 1.6px rgba(0,0,0,0.32));
    /* Off → on uses a slight overshoot easing so the cans look like
       they drop down and "settle" onto the head. Off has a faster,
       harder ease-in so they slip away cleanly. */
    transform: translateY(-26%) scale(0.7);
    opacity: 0;
    transform-origin: 50% 30%;
    transition:
      transform 0.32s cubic-bezier(0.34, 1.56, 0.64, 1),
      opacity 0.22s ease-out;
  }
  .music-headphones.playing {
    transform: translateY(0) scale(1);
    opacity: 1;
  }
  /* When transitioning OUT (playing flips false), use a snappier
     ease-in so the cans don't appear to bounce away. */
  .music-headphones:not(.playing) {
    transition:
      transform 0.22s ease-in,
      opacity 0.18s ease-in;
  }
  /* Earcup pulse — only animates while playing so the rest of the
     time there's no idle GPU work. Scales each cup around its own
     center; the two share the same 1.1s cycle so they breathe
     together, like wearing a single set of headphones. */
  .hp-cup-l { transform-origin: 10px 30px; }
  .hp-cup-r { transform-origin: 46px 30px; }
  .music-headphones.playing .hp-cup {
    animation: hp-pulse 1.1s ease-in-out infinite;
  }
  @keyframes hp-pulse {
    0%, 100% { transform: scale(1);    }
    50%       { transform: scale(1.12); }
  }
  /* Inner light brightens in sync with the cup scale — gives the
     pulse a glow component instead of just a size jiggle. */
  .music-headphones.playing .hp-light {
    animation: hp-light 1.1s ease-in-out infinite;
  }
  .hp-light { opacity: 0.55; }
  @keyframes hp-light {
    0%, 100% { opacity: 0.55; }
    50%       { opacity: 1;    }
  }
</style>
