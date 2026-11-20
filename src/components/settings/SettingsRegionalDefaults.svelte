<script>
  // Defaults for Everyone (from nutritrace#326): the language, date format
  // and time format that anyone who hasn't chosen their own starts with.
  // Admins only (Settings > Users). Nothing is written into anyone's
  // settings: a person's own choice always wins, and a change here reaches
  // everyone who still hasn't chosen. "Each Device" leaves it to the
  // browser or phone. One set in the server's environment (DEFAULT_*) shows
  // here, locked. The weight unit isn't one (server/lib/regional-options.js).
  import { onMount } from 'svelte';
  import { _ } from 'svelte-i18n';
  import { AVAILABLE_LOCALES } from '../../i18n/index.js';
  import { REGIONAL_OPTIONS } from '../../../server/lib/regional-options.js';
  import { applyInstanceDefaults } from '../../stores/settings.js';
  import { showSuccess, showError } from '../../stores/toast.js';

  let values = {};
  let locked = [];
  let loaded = false;
  let loadFailed = false;
  let busy = false;

  const langLabel = c => AVAILABLE_LOCALES.find(l => l.code === c)?.label || c;
  // The same words Settings > Units & Language shows.
  $: ROWS = [
    { key: 'language', label: $_('settings.units.language'), opts: REGIONAL_OPTIONS.language.values.map(v => [v, langLabel(v)]) },
    { key: 'dateFormat', label: $_('settings_units.date_format'), opts: [
      ['US', $_('settings_units.date_us')], ['EU', $_('settings_units.date_eu')], ['ISO', $_('settings_units.date_iso')]] },
    { key: 'timeFormat', label: $_('settings_units.time_format'), opts: [
      ['12h', $_('settings_units.time_12h')], ['24h', $_('settings_units.time_24h')]] },
  ];

  function _take(body) {
    values = body?.values || {};
    locked = Array.isArray(body?.locked) ? body.locked : [];
    applyInstanceDefaults(values);
  }

  onMount(async () => {
    try {
      const res = await fetch('/api/app-config/defaults', { credentials: 'include' });
      if (!res.ok) throw new Error(String(res.status));
      _take(await res.json());
    } catch {
      // Offline or refused: say so, rather than rows that look unset and
      // unlocked (one the environment holds would be refused on save).
      loadFailed = true;
    }
    loaded = true;
  });

  async function save(key, value) {
    const before = values;
    values = { ...values };
    if (value) values[key] = value; else delete values[key];
    busy = true;
    try {
      const res = await fetch('/api/app-config/defaults', {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: { [key]: value || null } }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `${res.status}`);
      _take(body);
      showSuccess($_('settings_defaults.saved'));
    } catch (e) {
      values = before;
      showError($_('settings_defaults.save_failed', { values: { msg: e?.message || '' } }));
    } finally { busy = false; }
  }
</script>

<div class="setting-divider"></div>
<div class="setting-row defaults-head">
  <div class="setting-label-group">
    <span class="setting-label">{$_('settings_defaults.title')}</span>
    <span class="setting-hint">{$_('settings_defaults.desc')}</span>
  </div>
</div>
{#if loadFailed}
  <p class="setting-hint defaults-failed">{$_('settings_defaults.load_failed')}</p>
{:else if loaded}
  {#each ROWS as row}
    <div class="setting-row defaults-row">
      <div class="setting-label-group">
        <span class="setting-label">{row.label}</span>
        {#if locked.includes(row.key)}
          <span class="setting-hint">{$_('settings_defaults.locked', { values: { env: REGIONAL_OPTIONS[row.key].env } })}</span>
        {/if}
      </div>
      <select class="form-select-sm" value={values[row.key] || ''} disabled={busy || locked.includes(row.key)}
              aria-label={row.label} on:change={e => save(row.key, e.target.value)}>
        <option value="">{$_('settings_defaults.device_choice')}</option>
        {#each row.opts as [v, label]}<option value={v}>{label}</option>{/each}
      </select>
    </div>
  {/each}
{/if}

<style>
  .defaults-head { padding-bottom: 4px; }
  .defaults-row { padding-left: 28px; }
  .defaults-failed { display: block; padding: 0 16px 12px; }
  .form-select-sm:disabled { opacity: 0.6; cursor: default; }
  @media (max-width: 480px) {
    .defaults-row { padding-left: 16px; }
  }
</style>
