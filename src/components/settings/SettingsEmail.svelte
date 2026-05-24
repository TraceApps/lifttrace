<script>
  import { slide } from 'svelte/transition';
  import { _ } from 'svelte-i18n';
  import Toggle from './Toggle.svelte';

  export let expanded = false;
  export let visible = true;
  export let onToggle = () => {};

  let smtpHost = '';
  let smtpPort = '587';
  let smtpSecure = false;
  let smtpUser = '';
  let smtpPass = '';
  let smtpShowPass = false;
  let smtpFrom = '';
  let smtpLocked = false;
  let smtpSaving = false;
  let smtpSaved = false;
  let smtpTestStatus = '';
  let _loaded = false;

  $: if (expanded && !_loaded) loadSmtpConfig();

  async function loadSmtpConfig() {
    _loaded = true;
    try {
      const locks = await fetch('/api/app-config/env-locks', { credentials: 'include' }).then(r => r.json());
      smtpLocked = locks.smtp;
      const cfg = await fetch('/api/app-config', { credentials: 'include' }).then(r => r.json());
      smtpHost   = cfg.smtp_host   || '';
      smtpPort   = cfg.smtp_port   || '587';
      smtpSecure = cfg.smtp_secure === 'true';
      smtpUser   = cfg.smtp_user   || '';
      smtpPass   = cfg.smtp_pass   || '';
      smtpFrom   = cfg.smtp_from   || '';
    } catch {}
  }

  async function saveSmtpField(key, value) {
    await fetch('/api/app-config', {
      method: 'PUT', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: `smtp_${key}`, value: String(value) }),
    }).catch(() => {});
  }

  async function saveSmtp() {
    smtpSaving = true;
    try {
      await saveSmtpField('host', smtpHost);
      await saveSmtpField('port', smtpPort);
      await saveSmtpField('secure', String(smtpSecure));
      await saveSmtpField('user', smtpUser);
      await saveSmtpField('pass', smtpPass);
      await saveSmtpField('from', smtpFrom);
      smtpSaved = true;
      setTimeout(() => smtpSaved = false, 2000);
    } finally { smtpSaving = false; }
  }

  async function testSmtp() {
    smtpTestStatus = 'testing';
    try {
      const res = await fetch('/api/app-config/test-email', { method: 'POST', credentials: 'include' });
      smtpTestStatus = res.ok ? 'ok' : 'fail';
    } catch { smtpTestStatus = 'fail'; }
  }
</script>

{#if visible}
  <button class="section-toggle" on:click={onToggle}>
    <span class="si"><span class="material-symbols-rounded">mail</span></span>
    <span class="section-name">{$_('settings.email.section')}</span>
    <span class="material-symbols-rounded chevron" class:rotated={expanded}>expand_more</span>
  </button>
  {#if expanded}
    <div class="section-body" transition:slide={{ duration: 180 }}>
      <p class="sub-label" style="padding-bottom:4px">Used for password resets and user invites</p>
      {#if smtpLocked}
        <div class="env-lock-banner">
          <span class="material-symbols-rounded" style="font-size:16px">lock</span>
          Configured via environment variables — changes are disabled.
        </div>
      {/if}
      <div class="card" style="padding:16px;display:flex;flex-direction:column;gap:12px">
        <div class="form-group">
          <label class="form-label">SMTP Host</label>
          <input class="form-input" type="text" placeholder="e.g. smtp.example.com"
            bind:value={smtpHost} disabled={smtpLocked} />
        </div>
        <div style="display:flex;gap:10px">
          <div class="form-group" style="flex:1">
            <label class="form-label">Port</label>
            <input class="form-input" type="number" placeholder="587"
              bind:value={smtpPort} disabled={smtpLocked} />
          </div>
          <div class="form-group" style="display:flex;flex-direction:column;gap:6px;justify-content:flex-end;padding-bottom:2px">
            <label class="form-label">TLS</label>
            <Toggle checked={smtpSecure} on:change={e => smtpSecure = e.detail} />
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Username</label>
          <input class="form-input" type="text" autocomplete="off" placeholder="SMTP username or email"
            bind:value={smtpUser} disabled={smtpLocked} />
        </div>
        <div class="form-group">
          <label class="form-label">Password</label>
          <div style="display:flex;gap:8px;align-items:center">
            {#if smtpShowPass}
              <input class="form-input" style="flex:1" type="text" autocomplete="new-password" placeholder="SMTP password or app password"
                bind:value={smtpPass} disabled={smtpLocked} />
            {:else}
              <input class="form-input" style="flex:1" type="password" autocomplete="new-password" placeholder="SMTP password or app password"
                bind:value={smtpPass} disabled={smtpLocked} />
            {/if}
            <button class="btn-icon-toggle" on:click={() => smtpShowPass = !smtpShowPass} title={smtpShowPass ? 'Hide' : 'Show'}>
              <span class="material-symbols-rounded">{smtpShowPass ? 'visibility_off' : 'visibility'}</span>
            </button>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">From address</label>
          <input class="form-input" type="email" placeholder="LiftTrace <noreply@example.com>"
            bind:value={smtpFrom} disabled={smtpLocked} />
        </div>
        <div style="display:flex;align-items:center;gap:10px">
          <button class="btn btn-primary" style="height:36px;font-size:13px"
            on:click={saveSmtp} disabled={smtpSaving || smtpLocked}>
            {#if smtpSaved}
              <span class="material-symbols-rounded" style="font-size:16px">check</span> Saved
            {:else}
              {smtpSaving ? 'Saving…' : 'Save'}
            {/if}
          </button>
          <button class="btn btn-secondary" style="height:36px;font-size:13px"
            on:click={testSmtp} disabled={!smtpHost || smtpTestStatus === 'testing'}>
            {smtpTestStatus === 'testing' ? 'Testing…' : 'Test'}
          </button>
          {#if smtpTestStatus === 'ok'}
            <span style="color:var(--success);font-size:13px;display:flex;align-items:center;gap:4px">
              <span class="material-symbols-rounded" style="font-size:16px">check_circle</span>Connected
            </span>
          {:else if smtpTestStatus === 'fail'}
            <span style="color:var(--danger);font-size:13px;display:flex;align-items:center;gap:4px">
              <span class="material-symbols-rounded" style="font-size:16px">error</span>Failed
            </span>
          {/if}
        </div>
      </div>
    </div>
  {/if}
{/if}

<style>
  .sub-label {
    font-size: 11px; font-weight: 700; letter-spacing: 0.06em;
    text-transform: uppercase; color: var(--text-3);
    padding: 4px 2px 2px; margin: 0;
  }
  .form-group { display: flex; flex-direction: column; gap: 6px; }
  .form-label { font-size: 13px; font-weight: 600; color: var(--text-2); }
  .form-input {
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-md); padding: 10px 14px;
    color: var(--text-1); font-size: 14px; font-family: inherit;
    outline: none; width: 100%; transition: border-color var(--dur-fast);
  }
  .form-input:focus { border-color: var(--accent); }
  .form-input:disabled { opacity: 0.5; cursor: not-allowed; }
  .env-lock-banner {
    display: flex; align-items: center; gap: 8px;
    padding: 10px 14px; margin-bottom: 8px;
    background: color-mix(in srgb, var(--warning) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--warning) 25%, transparent);
    border-radius: var(--radius-md);
    font-size: 13px; color: var(--warning);
  }
  .btn-icon-toggle {
    background: none; border: none; cursor: pointer; color: var(--text-3);
    padding: 6px; display: flex; border-radius: var(--radius-sm);
  }
  .btn-icon-toggle:hover { color: var(--text-1); background: var(--surface-2); }
</style>
