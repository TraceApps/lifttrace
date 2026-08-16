<script>
  /**
   * Shared settings row primitive. Every sub-page currently
   * hand-writes the same <div class="setting-row"><div><span
   * class="setting-label">…</span><div class="setting-hint">…</div>
   * </div>…control…</div> markup. Extracting it here means one
   * place to tweak density, one place to add responsive tweaks,
   * one place to add automated tests.
   *
   * Usage:
   *   <SettingRow label="Reduce Motion" desc="Turn off transitions and micro-animations">
   *     <Toggle bind:checked={$disableAnimations} />
   *   </SettingRow>
   *
   * The optional `divider` prop (default true) prepends the standard
   * hairline setting-divider so rows can be dropped one after
   * another inside a .card without extra bookkeeping. Set to false
   * on the FIRST row inside a card (no divider needed above it) or
   * when you want to lay rows out yourself.
   *
   * Ported from NutriTrace so the two apps stay uniform (byte-for-
   * byte identical component shape — LT keeps its existing
   * setting-hint class name for description text so no CSS changes
   * to the surrounding sections are needed).
   */
  export let label   = '';
  export let desc    = '';
  export let divider = true;
</script>

{#if divider}<div class="setting-divider"></div>{/if}
<div class="setting-row">
  <div class="sr-copy">
    <span class="setting-label">{label}</span>
    {#if desc}<div class="setting-hint">{desc}</div>{/if}
  </div>
  <div class="sr-control">
    <slot />
  </div>
</div>

<style>
  .sr-copy {
    min-width: 0;
    flex: 1;
  }
  .sr-control {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }
</style>
