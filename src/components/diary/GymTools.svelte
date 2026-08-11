<script>
  import { _ } from 'svelte-i18n';
  import { portal } from '../../lib/portal.js';
  import { weightUnit } from '../../stores/settings.js';

  export let open = false;

  let tab = 'plates'; // 'plates' | 'convert'

  // ── Plate Calculator ────────────────────────────────────────
  $: barWeight = $weightUnit === 'kg' ? 20 : 45;
  $: plates = $weightUnit === 'kg'
    ? [25, 20, 15, 10, 5, 2.5, 1.25]
    : [45, 35, 25, 10, 5, 2.5];
  let targetWeight = '';

  $: perSide = (() => {
    const total = parseFloat(targetWeight) || 0;
    const remaining = (total - barWeight) / 2;
    if (remaining <= 0) return [];
    let left = remaining;
    const result = [];
    for (const plate of plates) {
      while (left >= plate - 0.001) {
        result.push(plate);
        left -= plate;
      }
    }
    return result;
  })();

  $: remainder = (() => {
    const total = parseFloat(targetWeight) || 0;
    const used = perSide.reduce((s, p) => s + p, 0) * 2 + barWeight;
    return Math.round((total - used) * 100) / 100;
  })();

  // ── Unit Converter ──────────────────────────────────────────
  let convertInput = '';
  let convertDir = 'lbs_to_kg'; // 'lbs_to_kg' | 'kg_to_lbs'

  $: convertResult = (() => {
    const val = parseFloat(convertInput) || 0;
    if (convertDir === 'lbs_to_kg') return Math.round(val / 2.20462 * 100) / 100;
    return Math.round(val * 2.20462 * 100) / 100;
  })();

  // The unit being converted from, for the input label.
  $: convertFromUnit = convertDir === 'lbs_to_kg' ? 'lbs' : 'kg';

  // Plate colors for visual
  function plateColor(weight) {
    if ($weightUnit === 'kg') {
      if (weight >= 25) return '#FF5C5C';
      if (weight >= 20) return '#4FC3F7';
      if (weight >= 15) return '#FFD54F';
      if (weight >= 10) return '#4FFFB0';
      if (weight >= 5) return '#F0F2F8';
      return '#9FA8DA';
    }
    if (weight >= 45) return '#4FC3F7';
    if (weight >= 35) return '#FFD54F';
    if (weight >= 25) return '#4FFFB0';
    if (weight >= 10) return '#F0F2F8';
    if (weight >= 5) return '#FF80AB';
    return '#9FA8DA';
  }
</script>

{#if open}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div use:portal class="sheet-backdrop" on:click={() => open = false}>
    <div class="gt-sheet" on:click|stopPropagation on:keydown={() => {}}>
      <div class="sheet-handle"></div>
      <button class="gt-close-btn" on:click={() => open = false}
              aria-label={$_('common.close')} title={$_('common.close')}>
        <span class="material-symbols-rounded">close</span>
      </button>
      <div class="gt-tabs">
        <button class="gt-tab" class:active={tab === 'plates'} on:click={() => tab = 'plates'}>
          <span class="material-symbols-rounded" style="font-size:18px">fitness_center</span> {$_('gym_tools.plates')}
        </button>
        <button class="gt-tab" class:active={tab === 'convert'} on:click={() => tab = 'convert'}>
          <span class="material-symbols-rounded" style="font-size:18px">swap_horiz</span> {$_('gym_tools.convert')}
        </button>
      </div>

      {#if tab === 'plates'}
        <div class="gt-body">
          <div class="gt-input-row">
            <label class="form-label">{$_('gym_tools.target_weight')} <span class="unit">({$weightUnit})</span></label>
            <input class="input" type="number" step="0.5" bind:value={targetWeight}
                   placeholder={$weightUnit === 'kg' ? $_('gym_tools.weight_ph_kg') : $_('gym_tools.weight_ph_lb')} />
          </div>
          <div class="gt-bar-info">{$_('gym_tools.bar', { values: { weight: barWeight, unit: $weightUnit } })}</div>

          {#if perSide.length > 0}
            <div class="gt-result-label">{$_('gym_tools.each_side')}</div>
            <div class="gt-plates-visual">
              <div class="gt-bar-end"></div>
              {#each perSide as plate}
                <div class="gt-plate" style="background:{plateColor(plate)};height:{Math.max(28, 20 + plate * ($weightUnit === 'kg' ? 1.2 : 0.5))}px">
                  {plate}
                </div>
              {/each}
            </div>
            <div class="gt-plate-list">
              {#each [...new Set(perSide)] as plate}
                {@const count = perSide.filter(p => p === plate).length}
                <span class="gt-plate-chip" style="border-color:{plateColor(plate)};color:{plateColor(plate)}">
                  {count} × {plate} {$weightUnit}
                </span>
              {/each}
            </div>
            {#if remainder > 0.01}
              <div class="gt-remainder">⚠️ {$_('gym_tools.remainder', { values: { weight: remainder, unit: $weightUnit } })}</div>
            {/if}
          {:else if targetWeight}
            <div class="gt-empty">{$_('gym_tools.under_bar', { values: { weight: barWeight, unit: $weightUnit } })}</div>
          {/if}
        </div>

      {:else}
        <div class="gt-body">
          <div class="gt-convert-row">
            <select class="gt-convert-select" bind:value={convertDir}>
              <option value="lbs_to_kg">{$_('gym_tools.lbs_to_kg')}</option>
              <option value="kg_to_lbs">{$_('gym_tools.kg_to_lbs')}</option>
            </select>
          </div>
          <div class="gt-input-row">
            <label class="form-label">{convertDir === 'lbs_to_kg' ? $_('gym_tools.pounds') : $_('gym_tools.kilograms')} <span class="unit">({convertFromUnit})</span></label>
            <input class="input" type="number" step="0.1" bind:value={convertInput} placeholder={$_('gym_tools.weight_ph')} />
          </div>
          {#if convertInput}
            <div class="gt-convert-result">
              <span class="gt-convert-val">{convertResult}</span>
              <span class="gt-convert-unit">{convertDir === 'lbs_to_kg' ? 'kg' : 'lbs'}</span>
            </div>
          {/if}
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .sheet-backdrop {
    position: fixed; inset: 0; z-index: 200;
    background: rgba(0,0,0,0.5);
    display: flex; align-items: flex-end;
  }
  .sheet-handle { width: 36px; height: 4px; background: var(--border); border-radius: 2px; margin: 10px auto 0; }
  .gt-close-btn {
    position: absolute; top: 10px; right: 10px;
    z-index: 2;
    background: var(--surface-2); border: 1px solid var(--border);
    color: var(--text-3); cursor: pointer;
    width: 32px; height: 32px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
  }
  .gt-close-btn:hover { color: var(--text-1); }
  .gt-close-btn .material-symbols-rounded { font-size: 18px; }

  .gt-sheet {
    position: relative;
    background: var(--surface-1);
    border-radius: var(--radius-xl) var(--radius-xl) 0 0;
    width: 100%; max-width: 600px; margin: 0 auto;
    padding-bottom: var(--safe-bottom);
  }

  .gt-tabs {
    display: flex; gap: 0;
    border-bottom: 1px solid var(--border);
  }
  .gt-tab {
    flex: 1; padding: 12px 0;
    background: none; border: none; cursor: pointer;
    color: var(--text-3); font-size: 14px; font-weight: 600;
    display: flex; align-items: center; justify-content: center; gap: 6px;
    border-bottom: 2px solid transparent;
    transition: all var(--dur-fast);
  }
  .gt-tab.active { color: var(--accent); border-bottom-color: var(--accent); }

  .gt-body { padding: 16px 20px 20px; }

  .gt-input-row { margin-bottom: 12px; }
  .form-label { font-size: 13px; font-weight: 600; color: var(--text-2); margin-bottom: 6px; display: block; }
  .input {
    width: 100%; background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-md); padding: 10px 14px;
    color: var(--text-1); font-size: 16px; font-family: inherit; outline: none;
  }
  .input:focus { border-color: var(--accent); }

  .gt-bar-info { font-size: 12px; color: var(--text-3); margin-bottom: 16px; }
  .gt-result-label { font-size: 13px; font-weight: 700; color: var(--text-1); margin-bottom: 10px; }

  .gt-plates-visual {
    display: flex; align-items: center; gap: 3px;
    margin-bottom: 14px; padding: 8px 0;
  }
  .gt-bar-end {
    width: 60px; height: 8px;
    background: var(--text-3); border-radius: 4px;
    flex-shrink: 0;
  }
  .gt-plate {
    width: 22px; min-height: 28px;
    border-radius: 3px;
    display: flex; align-items: center; justify-content: center;
    font-size: 9px; font-weight: 700; color: #0A0B0F;
    flex-shrink: 0;
    writing-mode: vertical-rl;
    text-orientation: mixed;
  }

  .gt-plate-list {
    display: flex; flex-wrap: wrap; gap: 8px;
    margin-bottom: 12px;
  }
  .gt-plate-chip {
    padding: 4px 10px; border-radius: var(--radius-full);
    border: 1px solid; font-size: 13px; font-weight: 600;
  }

  .gt-remainder { font-size: 12px; color: var(--warning); }
  .gt-empty { font-size: 13px; color: var(--text-3); text-align: center; padding: 20px 0; }

  /* Converter */
  .gt-convert-row { margin-bottom: 12px; }
  .gt-convert-select {
    width: 100%; background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-md); padding: 10px 14px;
    color: var(--text-1); font-size: 14px; font-family: inherit;
  }
  .gt-convert-result {
    display: flex; align-items: baseline; gap: 8px;
    padding: 20px 0; text-align: center; justify-content: center;
  }
  .gt-convert-val { font-size: 36px; font-weight: 800; color: var(--accent); }
  .gt-convert-unit { font-size: 18px; color: var(--text-3); font-weight: 600; }
</style>
