<script>
  import { slide } from 'svelte/transition';
  import { _ } from 'svelte-i18n';
  import Toggle from './Toggle.svelte';
  import ConnectionStatus from './ConnectionStatus.svelte';
  import { showSuccess, showError } from '../../stores/toast.js';

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
  let smtpPassInputEl;

  // Server redacts stored passwords on GET and returns bullets as a
  // placeholder — the real value is never sent to the browser. Detect
  // that state so the toggle can't pretend to "reveal" a value we don't
  // have, and offer a clear Change action instead.
  const PASS_MASK = '••••••••';
  $: passIsStored = smtpPass === PASS_MASK;

  function changeSmtpPass() {
    smtpPass = '';
    smtpShowPass = false;
    // Next tick — after the input becomes editable, put the cursor in it.
    setTimeout(() => smtpPassInputEl?.focus(), 0);
  }

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

  let smtpTestRecipient = '';

  async function testSmtp() {
    if (!smtpHost) { smtpTestStatus = 'fail'; showError('SMTP test failed: host required'); return; }
    smtpTestStatus = 'testing';
    smtpTestRecipient = '';
    try {
      // Send the current form values so the user doesn't need to Save
      // first before testing. Omit the pass field when it's still the
      // mask so the server falls back to the stored password.
      const body = {
        smtp_host: smtpHost,
        smtp_port: String(smtpPort),
        smtp_secure: String(smtpSecure),
        smtp_user: smtpUser,
        smtp_from: smtpFrom,
      };
      if (smtpPass && smtpPass !== PASS_MASK) body.smtp_pass = smtpPass;
      const res = await fetch('/api/app-config/test-email', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        smtpTestRecipient = data.to || '';
        smtpTestStatus = 'ok';
        showSuccess(smtpTestRecipient
          ? `SMTP test email sent to ${smtpTestRecipient}`
          : 'SMTP test email sent, check your inbox');
      } else {
        smtpTestStatus = 'fail';
        let detail = `HTTP ${res.status}`;
        try { const j = await res.json(); if (j?.error) detail = j.error; } catch {}
        showError(`SMTP test failed: ${detail}`);
      }
    } catch (e) {
      smtpTestStatus = 'fail';
      showError(`SMTP test failed: ${e?.message || 'network error'}`);
    }
  }

  // Banner status mirrors NutriTrace's SMTP pattern: SMTP is fire-and-forget
  // (not a persistent connection) so the banner shows "Configured" as soon as
  // host + from are filled in (creds entered, never verified), and flips to
  // "Last Test Sent" after a successful test. A failed test takes priority.
  $: smtpBannerStatus = smtpTestStatus === 'testing' || smtpTestStatus === 'fail'
    ? smtpTestStatus
    : (smtpHost && smtpFrom ? 'ok' : '');
  $: smtpBannerLabel   = smtpTestStatus === 'ok' ? 'Last Test Sent' : 'Configured';
  $: smtpBannerSubtext = smtpTestStatus === 'ok'
    ? (smtpTestRecipient
        ? `Sent to ${smtpTestRecipient}. Use Send Test again any time to re-verify.`
        : 'Use Send Test again any time to re-verify')
    : 'No test has been sent yet';
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
        <ConnectionStatus
          status={smtpBannerStatus}
          okLabel={smtpBannerLabel}
          subtext={smtpBannerSubtext}
          error={smtpTestStatus === 'fail' ? 'Check host, credentials, and from address' : ''}
          onRetest={testSmtp}
          retestDisabled={smtpTestStatus === 'testing' || !smtpHost}
          retestLabel="Send Test"
        />
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
            <!-- Single input masked via CSS text-security instead of a
                 type-swap: on some Android WebView builds the swap left
                 stale password dots visible. When passIsStored is true
                 the field is read-only + the toggle is replaced with a
                 Change button, because the server redacts the real value
                 and there's nothing meaningful to "reveal". -->
            <input bind:this={smtpPassInputEl}
              class="form-input smtp-pass" class:masked={!smtpShowPass && !passIsStored}
              style="flex:1" type="text" autocomplete="new-password"
              placeholder="SMTP password or app password"
              bind:value={smtpPass} disabled={smtpLocked || passIsStored} />
            {#if passIsStored}
              <button type="button" class="btn-icon-toggle change-btn"
                on:click={changeSmtpPass}
                title="Change password"
                aria-label="Change password">
                Change
              </button>
            {:else}
              <button type="button" class="btn-icon-toggle"
                on:click={() => smtpShowPass = !smtpShowPass}
                title={smtpShowPass ? 'Hide' : 'Show'}
                aria-label={smtpShowPass ? 'Hide password' : 'Show password'}>
                <span class="material-symbols-rounded">{smtpShowPass ? 'visibility_off' : 'visibility'}</span>
              </button>
            {/if}
          </div>
          {#if passIsStored}
            <p class="pass-hint">Password saved. Tap Change to replace it.</p>
          {/if}
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
    background: none; border: 1px solid var(--border); cursor: pointer;
    color: var(--text-3); padding: 8px 10px; min-width: 40px; min-height: 40px;
    display: flex; align-items: center; justify-content: center;
    border-radius: var(--radius-sm);
  }
  .btn-icon-toggle:hover { color: var(--text-1); background: var(--surface-2); }
  .smtp-pass.masked {
    -webkit-text-security: disc;
    text-security: disc;
    font-family: text-security-disc, monospace;
    letter-spacing: 0.1em;
  }
  .smtp-pass:disabled {
    color: var(--text-3);
    cursor: not-allowed;
  }
  .btn-icon-toggle.change-btn {
    padding: 8px 12px; min-width: 0;
    font-size: 12px; font-weight: 700; font-family: inherit;
    color: var(--accent);
    border-color: var(--accent);
  }
  .pass-hint {
    margin: 4px 0 0; font-size: 11px; color: var(--text-3);
  }
</style>
