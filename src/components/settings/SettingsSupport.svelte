<script>
  /**
   * Support section of Settings. Passive by design: this page is the only
   * place the app asks for support. No banners, popups, or reminders
   * anywhere else. Money and free ways to help share the page, so everyone
   * who opens it has something to do. Same visible/expanded/onToggle prop
   * shape as SettingsAbout so it slots into the collapsible layout.
   */
  import { slide } from 'svelte/transition';
  import { _ } from 'svelte-i18n';

  export let expanded = false;
  export let visible = true;
  export let onToggle = () => {};

  // Full key literals (not built from a suffix) so i18n:check can verify them.
  const HELP = [
    { icon: 'star',       titleKey: 'settings_support.star',       descKey: 'settings_support.star_desc',       href: 'https://github.com/TraceApps/lifttrace' },
    { icon: 'bug_report', titleKey: 'settings_support.report_bug', descKey: 'settings_support.report_bug_desc', href: 'https://github.com/TraceApps/lifttrace/issues/new/choose' },
    { icon: 'translate',  titleKey: 'settings_support.translate',  descKey: 'settings_support.translate_desc',  href: 'https://hosted.weblate.org/engage/lifttrace/' },
  ];
</script>

{#if visible}
  <button class="section-toggle" on:click={onToggle}>
    <span class="si"><span class="material-symbols-rounded">volunteer_activism</span></span>
    <span class="section-name">{$_('settings.support.section')}</span>
    <span class="material-symbols-rounded chevron" class:rotated={expanded}>expand_more</span>
  </button>
  {#if expanded}
    <div class="section-body" transition:slide={{ duration: 180 }}>
      <div class="card">
        <div class="support-hero">
          <span class="material-symbols-rounded support-hero-icon">volunteer_activism</span>
          <p class="support-lead">{$_('settings_support.lead')}</p>
        </div>
        <div class="support-actions">
          <a href="https://ko-fi.com/traceapps" target="_blank" rel="noopener" class="btn btn-secondary support-btn">
            <span class="material-symbols-rounded">coffee</span> {$_('settings_support.kofi')}
          </a>
          <a href="https://github.com/sponsors/TraceApps?metadata_app=lifttrace&metadata_from=app" target="_blank" rel="noopener" class="btn btn-secondary support-btn">
            <span class="material-symbols-rounded">favorite</span> {$_('settings_support.github_sponsors')}
          </a>
        </div>
      </div>

      <div class="card">
        <div class="support-subhead">{$_('settings_support.other_ways')}</div>
        {#each HELP as h, i}
          {#if i > 0}<div class="setting-divider"></div>{/if}
          <a class="support-row" href={h.href} target="_blank" rel="noopener">
            <span class="material-symbols-rounded support-row-icon">{h.icon}</span>
            <span class="support-row-text">
              <span class="support-row-title">{$_(h.titleKey)}</span>
              <span class="support-row-desc">{$_(h.descKey)}</span>
            </span>
            <span class="material-symbols-rounded support-row-go">open_in_new</span>
          </a>
        {/each}
      </div>
    </div>
  {/if}
{/if}

<style>
  /* Section-specific styles. The shared framework classes
     (.section-toggle, .section-body, .card, .setting-divider, etc.)
     live in Settings.svelte's :global() block. */
  .support-hero {
    display: flex; align-items: flex-start; gap: 12px;
    padding: 16px 16px 4px;
  }
  .support-hero-icon { color: var(--accent); font-size: 28px; flex-shrink: 0; }
  .support-lead { margin: 0; font-size: 14px; line-height: 1.5; color: var(--text-1); }
  .support-actions {
    display: flex; flex-wrap: wrap; gap: 8px;
    padding: 12px 16px 16px 56px;
  }
  .support-btn { height: 38px; padding: 0 16px; gap: 6px; font-size: 13px; }
  .support-btn .material-symbols-rounded { font-size: 18px; }
  .support-subhead {
    font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase;
    color: var(--text-3); padding: 16px 16px 6px;
  }
  .support-row {
    display: flex; align-items: center; gap: 12px;
    padding: 12px 16px; color: var(--text-1); text-decoration: none;
  }
  .support-row:hover .support-row-title { color: var(--accent); }
  .support-row-icon { color: var(--accent); font-size: 22px; flex-shrink: 0; }
  .support-row-text { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
  .support-row-title { font-size: 14px; font-weight: 600; }
  .support-row-desc { font-size: 12px; color: var(--text-3); line-height: 1.4; }
  .support-row-go { color: var(--text-3); font-size: 18px; flex-shrink: 0; }
</style>
