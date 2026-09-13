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
  import { pageBanners, bannerStyle } from '../stores/settings.js';
  import { resolveAssetUrl } from '../lib/platform.js';

  let comparing = null;   // { before, after }
  let viewing = null;     // single photo

  function onCompare(e) { comparing = e.detail; }
  function onView(e)    { viewing = e.detail; }

  function fmtDate(d) {
    if (!d) return '';
    const parsed = new Date(`${d}T00:00:00`);
    return isNaN(parsed) ? d : parsed.toLocaleDateString();
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
  title={viewing ? fmtDate(viewing.date) : ''}
  height="full"
  wide
  on:close={() => viewing = null}
>
  {#if viewing}
    <div class="single">
      <img src={resolveAssetUrl(viewing.url)} alt={fmtDate(viewing.date)} />
    </div>
  {/if}
</Sheet>

<style>
  .single {
    display: flex; align-items: center; justify-content: center;
    width: 100%; height: 100%; padding: 8px;
  }
  .single img {
    max-width: 100%; max-height: 100%;
    object-fit: contain;
    border-radius: var(--radius-md);
  }
</style>
