<script>
  import { slide } from 'svelte/transition';
  import { _ } from 'svelte-i18n';
  import Toggle from './Toggle.svelte';
  import { statsChartType, statsYZero, statsAvgLine, statsTrendLine } from '../../stores/settings.js';

  export let expanded = false;
  export let visible = true;
  export let onToggle = () => {};
</script>

{#if visible}
  <button class="section-toggle" on:click={onToggle}>
    <span class="si"><span class="material-symbols-rounded">bar_chart</span></span>
    <span class="section-name">{$_('settings.statistics.section')}</span>
    <span class="material-symbols-rounded chevron" class:rotated={expanded}>expand_more</span>
  </button>
  {#if expanded}
    <div class="section-body" transition:slide={{ duration: 180 }}>
      <div class="card">
        <div class="setting-row">
          <span class="setting-label">{$_('settings_statistics.default_chart_type')}</span>
          <select class="form-select-sm" bind:value={$statsChartType}>
            <option value="bar">{$_('settings_statistics.type_bar')}</option>
            <option value="line">{$_('settings_statistics.type_line')}</option>
          </select>
        </div>
        <div class="setting-row">
          <div class="setting-label-group">
            <span class="setting-label">{$_('settings_statistics.lock_y_zero')}</span>
            <span class="setting-hint">{$_('settings_statistics.lock_y_zero_hint')}</span>
          </div>
          <Toggle bind:checked={$statsYZero} />
        </div>
        <div class="setting-row">
          <div class="setting-label-group">
            <span class="setting-label">{$_('settings_statistics.show_average')}</span>
            <span class="setting-hint">{$_('settings_statistics.show_average_hint')}</span>
          </div>
          <Toggle bind:checked={$statsAvgLine} />
        </div>
        <div class="setting-row">
          <div class="setting-label-group">
            <span class="setting-label">{$_('settings_statistics.show_trend')}</span>
            <span class="setting-hint">{$_('settings_statistics.show_trend_hint')}</span>
          </div>
          <Toggle bind:checked={$statsTrendLine} />
        </div>
      </div>
    </div>
  {/if}
{/if}
