<script>
  import { slide } from 'svelte/transition';
  import { weightUnit, dateFormat, timeFormat, language } from '../../stores/settings.js';
  import { _ } from 'svelte-i18n';
  import { AVAILABLE_LOCALES } from '../../i18n/index.js';

  export let expanded = false;
  export let visible = true;
  export let onToggle = () => {};
</script>

{#if visible}
  <button class="section-toggle" on:click={onToggle}>
    <span class="si"><span class="material-symbols-rounded">straighten</span></span>
    <span class="section-name">{$_('settings.units.section')}</span>
    <span class="material-symbols-rounded chevron" class:rotated={expanded}>expand_more</span>
  </button>
  {#if expanded}
    <div class="section-body" transition:slide={{ duration: 180 }}>
      <div class="card">
        <div class="setting-row">
          <span class="setting-label">{$_('settings.units.language')}</span>
          <select class="form-select-sm" bind:value={$language}>
            {#each AVAILABLE_LOCALES as l}<option value={l.code}>{l.label}</option>{/each}
          </select>
        </div>
        <div class="setting-divider"></div>
        <div class="setting-row">
          <span class="setting-label">Weight unit</span>
          <select class="form-select-sm" bind:value={$weightUnit}>
            <option value="lbs">lbs</option>
            <option value="kg">kg</option>
          </select>
        </div>
        <div class="setting-divider"></div>
        <div class="setting-row">
          <span class="setting-label">Date format</span>
          <select class="form-select-sm" bind:value={$dateFormat}>
            <option value="US">US (MM/DD/YYYY)</option>
            <option value="EU">EU (DD/MM/YYYY)</option>
            <option value="ISO">ISO (YYYY-MM-DD)</option>
          </select>
        </div>
        <div class="setting-row">
          <span class="setting-label">Time format</span>
          <select class="form-select-sm" bind:value={$timeFormat}>
            <option value="12h">12-hour</option>
            <option value="24h">24-hour</option>
          </select>
        </div>
      </div>
    </div>
  {/if}
{/if}
