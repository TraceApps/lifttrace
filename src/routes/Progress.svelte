<script>
  /**
   * Progress.svelte
   *
   * Dated progress photos and the before/after comparison, on their own
   * route rather than folded into Statistics. Photos are used
   * retrospectively (comparing two dates months apart), which is a
   * different job from Diary's day-by-day logging and needs more room
   * than a chart-swap tab, so it gets a page.
   *
   * Named "Progress" rather than "Progress photos" on purpose: the route
   * is the bookmark-able surface, so it carries the durable name even
   * though photos are the only media kind it holds today.
   */
  import { _ } from 'svelte-i18n';
  import Sheet from '../components/ui/Sheet.svelte';
  import ProgressPhotosTimeline from '../components/progress-photos/ProgressPhotosTimeline.svelte';
  import PhotoCompareSlider from '../components/progress-photos/PhotoCompareSlider.svelte';
  import PhotoScrubber from '../components/progress-photos/PhotoScrubber.svelte';
  import { pageBanners, bannerStyle } from '../stores/settings.js';

  let comparing = null;   // { before, after }
  let viewing = null;     // { photo, photos, statsByDate }

  function onCompare(e) { comparing = e.detail; }
  function onView(e)    { viewing = e.detail; }

  function weightFor(date) {
    const w = viewing?.statsByDate?.get(date)?.weight;
    return (w === undefined || w === null || w === '') ? null : w;
  }
</script>

<div class="page">
  <header class="page-header" class:banner-gradient={$bannerStyle === 'gradient'} class:banner-animated={$bannerStyle === 'animated'}>
    <h1>{$_('routes.progress.title')}</h1>
  </header>

  <div class="content">
    <ProgressPhotosTimeline on:compare={onCompare} on:view={onView} />
  </div>
</div>

<Sheet
  open={!!comparing}
  title={$_('progress.compare.title')}
  height="full"
  wide
  on:close={() => comparing = null}
>
  {#if comparing}
    <PhotoCompareSlider before={comparing.before} after={comparing.after} />
  {/if}
</Sheet>

<Sheet
  open={!!viewing}
  title={$_('progress.scrub.title')}
  height="full"
  wide
  on:close={() => viewing = null}
>
  {#if viewing}
    <PhotoScrubber
      photos={viewing.photos}
      startId={viewing.photo?.id}
      {weightFor}
    />
  {/if}
</Sheet>
