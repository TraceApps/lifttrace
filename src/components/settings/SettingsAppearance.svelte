<script>
  import { slide } from 'svelte/transition';
  import { _ } from 'svelte-i18n';
  import Toggle from './Toggle.svelte';
  import {
    appearance, applyAppearance, accentColor, applyAccentColor,
    navStyle, sidebarPersistent, startPage, disableAnimations,
    goalCelebrations, bannerStyle, bannerAnimation,
  } from '../../stores/settings.js';

  export let expanded = false;
  export let visible = true;
  export let onToggle = () => {};
  /** Called when the Custom swatch is tapped \u2014 parent opens the HSL/RGB sheet. */
  export let onOpenColorSheet = () => {};

  $: ACCENTS = [
    { id: 'orange', label: $_('settings_appearance.accents.orange'), color: '#FF7433' },
    { id: 'mint',   label: $_('settings_appearance.accents.mint'),   color: '#4FFFB0' },
    { id: 'blue',   label: $_('settings_appearance.accents.blue'),   color: '#4FC3F7' },
    { id: 'red',    label: $_('settings_appearance.accents.red'),    color: '#FF7070' },
    { id: 'purple', label: $_('settings_appearance.accents.purple'), color: '#CE93D8' },
    { id: 'teal',   label: $_('settings_appearance.accents.teal'),   color: '#4DD0E1' },
    { id: 'yellow', label: $_('settings_appearance.accents.yellow'), color: '#FFF176' },
    { id: 'indigo', label: $_('settings_appearance.accents.indigo'), color: '#9FA8DA' },
    { id: 'pink',   label: $_('settings_appearance.accents.pink'),   color: '#F48FB1' },
    { id: 'rose',   label: $_('settings_appearance.accents.rose'),   color: '#FF80AB' },
    { id: 'cyan',   label: $_('settings_appearance.accents.cyan'),   color: '#80DEEA' },
    { id: 'lime',   label: $_('settings_appearance.accents.lime'),   color: '#C5E1A5' },
  ];
  $: START_PAGES = [
    { value: '/',           label: $_('settings_appearance.start_diary')      },
    { value: '/exercises',  label: $_('settings_appearance.start_exercises')  },
    { value: '/programs',   label: $_('settings_appearance.start_programs')   },
    { value: '/statistics', label: $_('settings_appearance.start_statistics') },
    { value: '/settings',   label: $_('settings_appearance.start_settings')   },
  ];

  $: isCustomHex = /^#[0-9a-fA-F]{6}$/.test($accentColor);

  // Viewport gate — the persistent sidebar only makes sense on tablets +
  // desktop, so the toggle hides on phones. Tracks resize so a tablet user
  // rotating portrait↔landscape sees the toggle reappear without reloading.
  // Threshold matches App.svelte's _persistentAllowed (768px).
  let _viewportW = typeof window !== 'undefined' ? window.innerWidth : 1024;
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', () => { _viewportW = window.innerWidth; });
  }
  $: _persistentAllowed = _viewportW >= 768;
</script>

{#if visible}
  <button class="section-toggle" on:click={onToggle}>
    <span class="si"><span class="material-symbols-rounded">palette</span></span>
    <span class="section-name">{$_('settings.appearance.section')}</span>
    <span class="material-symbols-rounded chevron" class:rotated={expanded}>expand_more</span>
  </button>
  {#if expanded}
    <div class="section-body" transition:slide={{ duration: 180 }}>
      <div class="card">
        <!-- Order + labels mirrored from NutriTrace's Appearance section
             for cross-app consistency. Labels follow the title-case rule
             (Chicago — every word capitalized except small connectors). -->
        <div class="setting-row">
          <span class="setting-label">{$_('settings_appearance.theme')}</span>
          <select class="form-select-sm" value={$appearance} on:change={e => applyAppearance(e.target.value)}>
            <option value="system">{$_('settings_appearance.theme_system')}</option>
            <option value="dark">{$_('settings_appearance.theme_dark')}</option>
            <option value="light">{$_('settings_appearance.theme_light')}</option>
          </select>
        </div>
        <div class="setting-divider"></div>
        <div class="setting-row accent-row">
          <span class="setting-label">{$_('settings_appearance.accent_color')}</span>
          <div class="accent-grid">
            {#each ACCENTS as a}
              <button class="accent-swatch" class:active={$accentColor === a.id}
                style="background: {a.color}" on:click={() => applyAccentColor(a.id)}
                title={a.label}>
                {#if $accentColor === a.id}
                  <span class="material-symbols-rounded swatch-check">check</span>
                {/if}
              </button>
            {/each}
            <button
              class="accent-swatch accent-swatch-custom"
              class:active={isCustomHex}
              title={$_('settings_appearance.custom_color')}
              style={isCustomHex ? `background: ${$accentColor}` : ''}
              on:click={onOpenColorSheet}>
              {#if isCustomHex}
                <span class="material-symbols-rounded swatch-check">check</span>
              {:else}
                <span class="material-symbols-rounded swatch-colorize">colorize</span>
              {/if}
            </button>
          </div>
        </div>
        <div class="setting-divider"></div>
        <div class="setting-row">
          <span class="setting-label">{$_('settings_appearance.nav_style')}</span>
          <select class="form-select-sm" bind:value={$navStyle}>
            <option value="bottom">{$_('settings_appearance.nav_bottom')}</option>
            <option value="sidebar">{$_('settings_appearance.nav_sidebar')}</option>
            <option value="both">{$_('settings_appearance.nav_both')}</option>
          </select>
        </div>
        {#if $navStyle !== 'bottom' && _persistentAllowed}
          <div class="setting-divider"></div>
          <div class="setting-row">
            <div class="setting-label-group">
              <span class="setting-label">{$_('settings_appearance.persistent_sidebar')}</span>
              <span class="setting-hint">{$_('settings_appearance.persistent_sidebar_desc')}</span>
            </div>
            <Toggle bind:checked={$sidebarPersistent} />
          </div>
        {/if}
        <div class="setting-divider"></div>
        <div class="setting-row">
          <span class="setting-label">{$_('settings_appearance.start_page')}</span>
          <select class="form-select-sm" bind:value={$startPage}>
            {#each START_PAGES as sp}
              <option value={sp.value}>{sp.label}</option>
            {/each}
          </select>
        </div>
        <div class="setting-divider"></div>
        <div class="setting-row">
          <span class="setting-label">{$_('settings_appearance.reduce_motion')}</span>
          <Toggle bind:checked={$disableAnimations} />
        </div>
        <div class="setting-divider"></div>
        <div class="setting-row">
          <div class="setting-label-group">
            <span class="setting-label">{$_('settings_appearance.goal_celebrations')}</span>
            <span class="setting-hint">{$_('settings_appearance.goal_celebrations_desc')}</span>
          </div>
          <Toggle bind:checked={$goalCelebrations} />
        </div>
        <div class="setting-divider"></div>
        <div class="setting-row">
          <div class="setting-label-group">
            <span class="setting-label">{$_('settings_appearance.page_banners')}</span>
            <span class="setting-hint">{$_('settings_appearance.page_banners_desc')}</span>
          </div>
          <select class="form-select-sm" value={$bannerStyle} on:change={e => bannerStyle.set(e.target.value)}>
            <option value="animated">{$_('settings_appearance.banner_animated')}</option>
            <option value="gradient">{$_('settings_appearance.banner_gradient')}</option>
            <option value="off">{$_('settings_appearance.banner_off')}</option>
          </select>
        </div>
        {#if $bannerStyle === 'animated'}
          <div class="setting-row">
            <div class="setting-label-group">
              <span class="setting-label">{$_('settings_appearance.anim_style')}</span>
              <span class="setting-hint">{$_('settings_appearance.anim_style_desc')}</span>
            </div>
            <select class="form-select-sm" value={$bannerAnimation} on:change={e => bannerAnimation.set(e.target.value)}>
              <option value="shimmer">{$_('settings_appearance.anim_shimmer')}</option>
              <option value="drift">{$_('settings_appearance.anim_drift')}</option>
              <option value="pulse">{$_('settings_appearance.anim_pulse')}</option>
              <option value="aurora">{$_('settings_appearance.anim_aurora')}</option>
            </select>
          </div>
        {/if}
      </div>
    </div>
  {/if}
{/if}

<style>
  /* Accent row — label sits above the swatch grid (matches NutriTrace's
     stacked layout: easier to scan when there are 12+ swatches than the
     squeezed inline arrangement). */
  .accent-row {
    align-items: flex-start;
    flex-direction: column;
    gap: 10px;
  }
  .accent-grid { display: flex; gap: 8px; flex-wrap: wrap; }
  .accent-swatch {
    width: 28px; height: 28px; border-radius: 50%;
    border: 2px solid transparent; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    transition: transform var(--dur-fast), border-color var(--dur-fast);
  }
  .accent-swatch.active { border-color: var(--text-1); transform: scale(1.15); }
  .accent-swatch:hover { transform: scale(1.08); }
  .swatch-check    { font-size: 16px; color: #fff; text-shadow: 0 1px 2px rgba(0,0,0,0.4); }
  .swatch-colorize { font-size: 16px; color: rgba(255,255,255,0.9); text-shadow: 0 0 3px rgba(0,0,0,0.5); }
  .accent-swatch-custom { background: conic-gradient(red, yellow, lime, cyan, blue, magenta, red); }
</style>
