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

  const ACCENTS = [
    { id: 'orange', label: 'Iron',    color: '#FF7433' },
    { id: 'mint',   label: 'Mint',    color: '#4FFFB0' },
    { id: 'blue',   label: 'Blue',    color: '#4FC3F7' },
    { id: 'red',    label: 'Red',     color: '#FF7070' },
    { id: 'purple', label: 'Purple',  color: '#CE93D8' },
    { id: 'teal',   label: 'Teal',    color: '#4DD0E1' },
    { id: 'yellow', label: 'Gold',    color: '#FFF176' },
    { id: 'indigo', label: 'Indigo',  color: '#9FA8DA' },
    { id: 'pink',   label: 'Pink',    color: '#F48FB1' },
    { id: 'rose',   label: 'Rose',    color: '#FF80AB' },
    { id: 'cyan',   label: 'Cyan',    color: '#80DEEA' },
    { id: 'lime',   label: 'Lime',    color: '#C5E1A5' },
  ];
  const START_PAGES = [
    { value: '/',           label: 'Diary'      },
    { value: '/exercises',  label: 'Exercises'  },
    { value: '/programs',   label: 'Programs'   },
    { value: '/statistics', label: 'Statistics' },
    { value: '/settings',   label: 'Settings'   },
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
          <span class="setting-label">Theme</span>
          <select class="form-select-sm" value={$appearance} on:change={e => applyAppearance(e.target.value)}>
            <option value="system">System Default</option>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
        </div>
        <div class="setting-divider"></div>
        <div class="setting-row accent-row">
          <span class="setting-label">Accent Color</span>
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
              title="Custom Color"
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
          <span class="setting-label">Navigation Style</span>
          <select class="form-select-sm" bind:value={$navStyle}>
            <option value="bottom">Bottom Bar</option>
            <option value="sidebar">Sidebar</option>
            <option value="both">Both</option>
          </select>
        </div>
        {#if $navStyle !== 'bottom' && _persistentAllowed}
          <div class="setting-divider"></div>
          <div class="setting-row">
            <div class="setting-label-group">
              <span class="setting-label">Persistent Sidebar</span>
              <span class="setting-hint">Sidebar stays open and shifts page content instead of overlaying it. Available on tablets, foldables, and desktop.</span>
            </div>
            <Toggle bind:checked={$sidebarPersistent} />
          </div>
        {/if}
        <div class="setting-divider"></div>
        <div class="setting-row">
          <span class="setting-label">Start Page</span>
          <select class="form-select-sm" bind:value={$startPage}>
            {#each START_PAGES as sp}
              <option value={sp.value}>{sp.label}</option>
            {/each}
          </select>
        </div>
        <div class="setting-divider"></div>
        <div class="setting-row">
          <span class="setting-label">Reduce Motion</span>
          <Toggle bind:checked={$disableAnimations} />
        </div>
        <div class="setting-divider"></div>
        <div class="setting-row">
          <div class="setting-label-group">
            <span class="setting-label">Goal Celebrations</span>
            <span class="setting-hint">Confetti when you hit a milestone</span>
          </div>
          <Toggle bind:checked={$goalCelebrations} />
        </div>
        <div class="setting-divider"></div>
        <div class="setting-row">
          <div class="setting-label-group">
            <span class="setting-label">Page Banners</span>
            <span class="setting-hint">Header style at the top of every page. Animated is a compact accent-gradient bar with a chosen motion style; Gradient is the same bar, static; Off is a plain glass header.</span>
          </div>
          <select class="form-select-sm" value={$bannerStyle} on:change={e => bannerStyle.set(e.target.value)}>
            <option value="animated">Animated</option>
            <option value="gradient">Gradient</option>
            <option value="off">Off</option>
          </select>
        </div>
        {#if $bannerStyle === 'animated'}
          <div class="setting-row">
            <div class="setting-label-group">
              <span class="setting-label">Animation Style</span>
              <span class="setting-hint">Shimmer is a soft white sweep, Drift is a slow hue rotation, Pulse is a gentle breathing, Aurora is a soft accent-tinted cloud-of-light. All honour Reduce Motion.</span>
            </div>
            <select class="form-select-sm" value={$bannerAnimation} on:change={e => bannerAnimation.set(e.target.value)}>
              <option value="shimmer">Shimmer</option>
              <option value="drift">Drift</option>
              <option value="pulse">Pulse</option>
              <option value="aurora">Aurora</option>
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
