<script>
  import { onMount } from 'svelte';
  import { push, location } from 'svelte-spa-router';

  // Embedded mode: when Profile renders inside the Settings shell (as
  // the /settings/profile section OR inline inside the desktop welcome
  // hero at /settings), the outer Settings chrome already supplies the
  // title / back button and we shouldn't duplicate them. Matches both
  // '/settings' and '/settings/profile' via startsWith. Ports NT's
  // pattern so the family stays uniform.
  $: _embedded = ($location || '').startsWith('/settings');
  import { _ } from 'svelte-i18n';
  import { get } from 'svelte/store';
  import { currentUser, userMgmtActive, logout as logoutAuth } from '../stores/auth.js';
  import { showSuccess, showError } from '../stores/toast.js';
  import { validatePassword, passwordStrength } from '../lib/validation.js';
  import { localDateStr, DB } from '../lib/db.js';
  import { resolveAssetUrl, isNative, getServerUrl, getAuthToken } from '../lib/platform.js';
  import Toggle from '../components/settings/Toggle.svelte';
  import { biometricLoginEnabled } from '../stores/settings.js';
  import * as biometric from '../lib/biometric.js';

  // Probe biometric on mount. Render the row when biometric is fully
  // working OR when hardware exists but no fingerprint is enrolled (so the
  // user knows it's one Android-Settings step away). Hide entirely when no
  // biometric hardware exists — no point showing a setting the device
  // can't ever support.
  let _biometricStatus = null; // { isAvailable, reason, code, biometryType }
  $: _biometricSupported  = !!_biometricStatus?.isAvailable;
  $: _biometricRowVisible = _biometricSupported || _biometricStatus?.code === 'biometryNotEnrolled';
  async function onBiometricToggle(e) {
    const want = e.detail;
    if (want) {
      // Verify hardware right at toggle-on so failures surface immediately
      // instead of letting the user enable a setting that never works.
      const ok = await biometric.authenticate('Enable biometric sign-in');
      if (!ok) {
        biometricLoginEnabled.set(false);
        showError($_('profile.biometric_cancelled'));
        return;
      }
      // Stash the current JWT so the next sign-in can unlock with biometric.
      const tok = getAuthToken();
      if (tok) await biometric.saveTokenForBiometric(tok);
      biometricLoginEnabled.set(true);
    } else {
      await biometric.clearSavedToken();
      biometricLoginEnabled.set(false);
    }
  }
  import { heightCm as heightCmStore, currentWeightKg, heightUnit, weightUnit } from '../stores/settings.js';
  import { cmToFtIn, ftInToCm, toKg } from '../lib/workout.js';

  // "Local" editor mode = no server-backed user account exists. Covers two
  // cases: (a) Capacitor standalone with no server URL, and (b) PWA / server
  // mode without user management enabled (single-user instance). In both,
  // name/nickname/birthday/gender/avatar are stored in user_settings under
  // localUser* keys + dob + gender (same keys the wizard writes).
  const _isLocal = (isNative && !getServerUrl()) || !get(userMgmtActive);
  import { confirmDialog } from '../stores/confirmDialog.js';
  import { loadAuthState } from '../stores/auth.js';
  import DateInput from '../components/ui/DateInput.svelte';

  // Logout — only meaningful when there's a server-backed session, so the
  // template gates the button on `!_isLocal && $userMgmtActive`.
  let loggingOut = false;
  async function doLogout() {
    if (loggingOut) return;
    loggingOut = true;
    document.body.style.transition = 'opacity 0.3s';
    document.body.style.opacity = '0';
    try { await logoutAuth(); } catch {}
    setTimeout(() => window.location.reload(), 300);
  }

  let deletingAccount = false;
  async function deleteMyAccount() {
    if (!await confirmDialog({
      title: $_('profile.delete_account_title'),
      message: $_('profile.delete_account_message'),
      confirmText: $_('profile.delete_account_confirm'),
      dangerous: true,
    })) return;
    deletingAccount = true;
    try {
      const res = await fetch('/api/auth/me', { method: 'DELETE', credentials: 'include' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { showError(data?.error || $_('profile.errors.delete_account_failed')); deletingAccount = false; return; }
      localStorage.removeItem('wl:userId');
      await loadAuthState();
      showSuccess($_('profile.account_deleted'));
      push('/settings');
    } catch (e) {
      showError(e.message);
      deletingAccount = false;
    }
  }

  let fullName = '';
  let nickname = '';
  let email    = '';
  let birthday = '';
  let gender   = '';
  let avatarUrl = '';
  let saving   = false;

  // Height — stored as heightCm (centimetres) regardless of display unit.
  // The metric input edits heightCmInput directly; the imperial input edits
  // heightFt + heightIn and re-derives heightCmInput on change. Saving
  // writes whichever path the user used to the heightCm setting.
  let heightCmInput = '';
  let heightFt = '';
  let heightIn = '';
  $: _isMetricHeight = $heightUnit === 'cm' || $weightUnit === 'kg';

  // Current weight — stored as currentWeightKg (kg) regardless of display
  // unit. The input shows the value in the user's chosen weightUnit and
  // converts on save.
  let weightInput = '';

  // Password change
  let currentPassword = '';
  let newPassword     = '';
  let confirmPassword = '';
  let changingPw      = false;
  let showPw          = false;

  // Avatar
  let fileInput;

  // OIDC: provider list + linked accounts for the current user
  let oidcProviders = [];
  let linkedProviders = [];
  let unlinking = null;
  async function loadOidc() {
    try {
      const r = await fetch('/api/auth/oidc/providers', { credentials: 'include' });
      if (r.ok) {
        const data = await r.json();
        oidcProviders = data?.providers || [];
      }
    } catch {}
    try {
      const r2 = await fetch('/api/auth/oidc/links', { credentials: 'include' });
      if (r2.ok) {
        const data = await r2.json();
        linkedProviders = data?.links || [];
      }
    } catch {}
  }
  function startLink(providerId) {
    const ret = encodeURIComponent('#/profile');
    window.location.href = `/api/auth/oidc/login/${providerId}?link=1&return=${ret}`;
  }
  async function unlink(linkId) {
    if (!confirm('Unlink this provider? You won’t be able to sign in with it again until you re-link.')) return;
    unlinking = linkId;
    try {
      const r = await fetch(`/api/auth/oidc/unlink/${linkId}`, {
        method: 'POST', credentials: 'include',
      });
      const data = await r.json();
      if (!r.ok) { showError(data?.error || $_('profile.errors.unlink_failed')); return; }
      linkedProviders = data.links || [];
      showSuccess($_('profile.unlinked'));
    } catch (e) {
      showError($_('profile.server_unreachable'));
    } finally { unlinking = null; }
  }
  $: linkedProviderIds = new Set(linkedProviders.map(l => l.oidc_provider_id));
  $: availableToLink = oidcProviders.filter(p => !linkedProviderIds.has(p.id));

  onMount(() => {
    // Probe biometric so the row can render with an accurate status hint.
    biometric.getStatus().then(s => { _biometricStatus = s; }).catch(() => { _biometricStatus = { isAvailable: false, reason: 'Probe failed' }; });
    if (_isLocal) {
      // Read profile fields from user_settings (where the wizard wrote them).
      // localUserName + localUserNickname + localUserAvatar are local-mode-only
      // keys; dob + gender are shared with the wizard.
      fullName  = DB.getSetting('localUserName',     '') || '';
      nickname  = DB.getSetting('localUserNickname', '') || '';
      birthday  = DB.getSetting('dob',               '') || '';
      gender    = DB.getSetting('gender',            '') || '';
      avatarUrl = DB.getSetting('localUserAvatar',   '') || '';
      email     = '';
      // NOTE: don't early-return — height + weight reads below apply to
      // local mode too (they're settings-backed in both modes).
    } else if ($currentUser) {
      fullName  = $currentUser.full_name  || '';
      nickname  = $currentUser.nickname   || '';
      email     = $currentUser.email      || '';
      birthday  = $currentUser.birthday   || '';
      gender    = $currentUser.gender     || '';
      avatarUrl = $currentUser.avatar_url || '';
    }
    // Height + weight are always settings-backed (not users-table fields)
    // and apply to both local and server modes.
    const cm = $heightCmStore;
    if (cm) {
      heightCmInput = String(cm);
      const { ft, in: inches } = cmToFtIn(cm);
      heightFt = String(ft);
      heightIn = String(inches);
    }
    const kg = $currentWeightKg;
    if (kg) {
      const display = $weightUnit === 'kg' ? kg : kg * 2.2046226218;
      weightInput = String(Math.round(display * 10) / 10);
    }
    if (!_isLocal) loadOidc();
  });

  function getInitial() {
    return (fullName || nickname || $currentUser?.username || '?')[0].toUpperCase();
  }

  async function pickAvatar() {
    fileInput.click();
  }

  async function handleAvatarFile(e) {
    const file = e.target?.files?.[0];
    if (!file) return;
    const form = new FormData();
    form.append('file', file);
    try {
      const res = await fetch('/api/upload', { method: 'POST', credentials: 'include', body: form });
      if (!res.ok) throw new Error('Upload failed');
      const { url } = await res.json();
      avatarUrl = url;
    } catch(e) {
      showError(e.message);
    }
    e.target.value = '';
  }

  async function save() {
    saving = true;
    try {
      // Height — applies to both modes since it's settings-backed.
      const finalCm = _isMetricHeight
        ? (heightCmInput ? Number(heightCmInput) : null)
        : ((heightFt || heightIn) ? ftInToCm(heightFt, heightIn) : null);
      $heightCmStore = finalCm || null;
      // Current weight — convert to kg before saving.
      if (weightInput) {
        const v = Number(weightInput);
        if (v > 0) $currentWeightKg = Math.round(toKg(v, $weightUnit) * 10) / 10;
      }

      if (_isLocal) {
        // Write each field to its corresponding setting, then refresh
        // currentUser so Sidebar / Trace / etc. pick up the new name + avatar.
        DB.setSetting('localUserName',     fullName.trim()  || '');
        DB.setSetting('localUserNickname', nickname.trim()  || '');
        DB.setSetting('dob',               birthday         || '');
        DB.setSetting('gender',            gender           || '');
        if (avatarUrl) DB.setSetting('localUserAvatar', avatarUrl);
        try { await loadAuthState(); } catch {}
        showSuccess($_('profile.saved'));
        push('/settings');
        return;
      }
      const res = await fetch('/api/auth/profile', {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ full_name: fullName, nickname, email, birthday, gender, avatar_url: avatarUrl }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      const { user } = await res.json();
      currentUser.set(user);
      showSuccess($_('profile.saved'));
      push('/settings');
    } catch(e) {
      showError(e.message);
    } finally {
      saving = false;
    }
  }

  $: pwError = newPassword ? validatePassword(newPassword) : null;
  $: pwMatch = confirmPassword && newPassword !== confirmPassword ? $_('reset_password.errors.mismatch') : null;
  $: pwScore = passwordStrength(newPassword);

  async function changePassword() {
    if (pwError || pwMatch) return;
    changingPw = true;
    try {
      const res = await fetch('/api/auth/password', {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      showSuccess($_('profile.password_changed'));
      currentPassword = ''; newPassword = ''; confirmPassword = '';
    } catch(e) {
      showError(e.message);
    } finally {
      changingPw = false;
    }
  }
</script>

<div class="page" class:profile-embedded={_embedded}>
  {#if !_embedded}
    <header class="page-header">
      <button class="btn-icon back-btn" on:click={() => push('/settings')}>
        <span class="material-symbols-rounded">arrow_back</span>
      </button>
      <h1>{$_('routes.profile.title')}</h1>
      <button class="btn btn-primary save-btn" on:click={save} disabled={saving}>
        {saving ? $_('common.saving') : $_('common.save')}
      </button>
    </header>
  {/if}

  <div class="page-content">
    {#if _embedded}
      <!-- Embedded save button. The Settings shell owns the outer header,
           so this stands in for the standalone header's Save. Sits at the
           top of the body so it's the first thing the user sees when they
           want to commit changes. -->
      <div class="profile-embedded-save">
        <button class="btn btn-primary" on:click={save} disabled={saving}>
          {saving ? $_('common.saving') : $_('common.save')}
        </button>
      </div>
    {/if}
    <!-- Avatar -->
    <div class="avatar-section">
      <!-- svelte-ignore a11y-click-events-have-key-events -->
      <!-- svelte-ignore a11y-no-static-element-interactions -->
      <div class="avatar-wrap" on:click={pickAvatar}>
        {#if avatarUrl}
          <img class="avatar-img" src={resolveAssetUrl(avatarUrl)} alt="Avatar" />
        {:else}
          <span class="avatar-initial">{getInitial()}</span>
        {/if}
        <div class="avatar-overlay">
          <span class="material-symbols-rounded" style="font-size:24px">photo_camera</span>
        </div>
      </div>
      <input bind:this={fileInput} type="file" accept="image/*" style="display:none" on:change={handleAvatarFile} />
      <span class="avatar-name">{nickname || fullName || $currentUser?.username}</span>
    </div>

    <!-- Personal Info -->
    <div class="section-label">{$_('profile.personal_info')}</div>
    <div class="card">
      <div class="form-group">
        <label class="form-label">{$_('profile.full_name')}</label>
        <input class="form-input" type="text" bind:value={fullName} placeholder={$_('profile.full_name_placeholder')} />
      </div>
      {#if !_isLocal}
      <div class="form-group">
        <label class="form-label">{$_('forgot_password.email_label')}</label>
        <input class="form-input" type="email" bind:value={email} placeholder="you@example.com" />
      </div>
      {/if}
      <div class="form-group">
        <label class="form-label">{$_('profile.nickname')}</label>
        <input class="form-input" type="text" bind:value={nickname} placeholder={$_('profile.nickname_placeholder')} />
      </div>
      <div class="form-group">
        <label class="form-label">{$_('profile.birthday')}</label>
        <DateInput bind:value={birthday} max={localDateStr()} />
      </div>
      <div class="form-group">
        <label class="form-label">{$_('profile.gender.label')}</label>
        <select class="form-select" bind:value={gender}>
          <option value="">{$_('profile.gender.unset')}</option>
          <option value="male">{$_('profile.gender.male')}</option>
          <option value="female">{$_('profile.gender.female')}</option>
          <option value="non-binary">Non-binary</option>
          <option value="other">{$_('profile.gender.other')}</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">{$_('wizard.profile.height')}</label>
        {#if _isMetricHeight}
          <div class="height-row">
            <input class="form-input" type="number" inputmode="numeric"
              min="50" max="250" placeholder="cm" bind:value={heightCmInput} />
            <span class="height-unit">cm</span>
          </div>
        {:else}
          <div class="height-row">
            <input class="form-input height-narrow" type="number" inputmode="numeric"
              min="3" max="8" placeholder="ft" bind:value={heightFt} />
            <span class="height-unit">ft</span>
            <input class="form-input height-narrow" type="number" inputmode="numeric"
              min="0" max="11" placeholder="in" bind:value={heightIn} />
            <span class="height-unit">in</span>
          </div>
        {/if}
      </div>
      <div class="form-group">
        <label class="form-label">{$_('wizard.profile.weight')}</label>
        <div class="height-row">
          <input class="form-input" type="number" inputmode="decimal"
            step="0.1" min="20" max="500"
            placeholder={$weightUnit === 'kg' ? 'kg' : 'lbs'}
            bind:value={weightInput} />
          <span class="height-unit">{$weightUnit === 'kg' ? 'kg' : 'lbs'}</span>
        </div>
      </div>
    </div>

    {#if !_isLocal && (oidcProviders.length || linkedProviders.length)}
      <div class="section-label">{$_('profile.linked_accounts')}</div>
      <div class="card">
        {#if linkedProviders.length}
          <div class="oidc-link-list">
            {#each linkedProviders as l (l.id)}
              <div class="oidc-link-row">
                {#if l.logo_url}
                  <img src={resolveAssetUrl(l.logo_url)} alt="" class="oidc-link-logo" />
                {:else}
                  <span class="material-symbols-rounded oidc-link-icon">verified_user</span>
                {/if}
                <div class="oidc-link-info">
                  <span class="oidc-link-name">{l.display_name || 'OIDC'}</span>
                  {#if l.last_login_at}
                    <span class="oidc-link-meta">{$_('profile.last_signin', { values: { date: new Date(l.last_login_at).toLocaleDateString() } })}</span>
                  {/if}
                </div>
                <button class="btn btn-ghost btn-sm" on:click={() => unlink(l.id)} disabled={unlinking === l.id}>
                  {unlinking === l.id ? '…' : $_('profile.unlink')}
                </button>
              </div>
            {/each}
          </div>
        {:else}
          <p class="oidc-link-empty">{$_('profile.no_linked_accounts')}</p>
        {/if}
        {#if availableToLink.length}
          <div class="oidc-link-add">
            {#each availableToLink as p (p.id)}
              <button class="btn btn-secondary" on:click={() => startLink(p.id)}>
                {#if p.logo_url}
                  <img src={resolveAssetUrl(p.logo_url)} alt="" class="oidc-link-logo" />
                {:else}
                  <span class="material-symbols-rounded oidc-link-icon">add_link</span>
                {/if}
                <span>{$_('profile.link_with')} {p.display_name || 'SSO'}</span>
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {/if}

    <!-- Change Password (server mode only — no auth in local mode) -->
    {#if !_isLocal}
    <div class="section-label">{$_('profile.security')}</div>
    <div class="card">
      <div class="form-group">
        <label class="form-label">{$_('profile.current_password')}</label>
        <div class="pw-wrap">
          {#if showPw}
            <input class="form-input" type="text" bind:value={currentPassword} placeholder={$_('profile.current_password_ph')} />
          {:else}
            <input class="form-input" type="password" bind:value={currentPassword} placeholder={$_('profile.current_password_ph')} />
          {/if}
          <button class="pw-toggle" on:click={() => showPw = !showPw} type="button">
            <span class="material-symbols-rounded">{showPw ? 'visibility_off' : 'visibility'}</span>
          </button>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">{$_('reset_password.new_password')}</label>
        {#if showPw}
          <input class="form-input" type="text" autocomplete="new-password" passwordrules="minlength: 8; required: upper; required: lower; required: digit; required: special;" bind:value={newPassword} placeholder={$_('reset_password.password_placeholder')} />
        {:else}
          <input class="form-input" type="password" autocomplete="new-password" passwordrules="minlength: 8; required: upper; required: lower; required: digit; required: special;" bind:value={newPassword} placeholder={$_('reset_password.password_placeholder')} />
        {/if}
        {#if newPassword}
          <div class="pw-strength" class:s-0={pwScore.score === 0} class:s-1={pwScore.score === 1} class:s-2={pwScore.score === 2} class:s-3={pwScore.score === 3} class:s-4={pwScore.score === 4}>
            <div class="pw-bar"><div class="pw-fill" style:width={`${(pwScore.score / 4) * 100}%`}></div></div>
            <span class="pw-label">{pwScore.label}</span>
          </div>
        {/if}
        {#if pwError}<span class="form-error">{pwError}</span>{/if}
      </div>
      <div class="form-group">
        <label class="form-label">{$_('profile.confirm_new_password')}</label>
        {#if showPw}
          <input class="form-input" type="text" autocomplete="new-password" passwordrules="minlength: 8; required: upper; required: lower; required: digit; required: special;" bind:value={confirmPassword} placeholder={$_('profile.confirm_password_ph')} />
        {:else}
          <input class="form-input" type="password" autocomplete="new-password" passwordrules="minlength: 8; required: upper; required: lower; required: digit; required: special;" bind:value={confirmPassword} placeholder={$_('profile.confirm_password_ph')} />
        {/if}
        {#if pwMatch}<span class="form-error">{pwMatch}</span>{/if}
      </div>
      <button
        class="btn btn-primary change-pw-btn"
        on:click={changePassword}
        disabled={changingPw || !currentPassword || !newPassword || !confirmPassword || !!pwError || !!pwMatch}
      >
        {changingPw ? $_('common.saving') : $_('profile.change_password')}
      </button>
    </div>
    {/if}

    <!-- Biometric sign-in (Android server-mode only). Hidden on devices
         with no biometric hardware. Visible when working OR when hardware
         is present but no fingerprint/face is enrolled — the description
         tells the user how to finish setup in Android Settings. -->
    {#if isNative && !_isLocal && _biometricRowVisible}
    <div class="card">
      <div class="setting-row">
        <span class="material-symbols-rounded security-icon">fingerprint</span>
        <div style="flex:1;min-width:0">
          <span class="security-label">{$_('profile.biometric_signin')}</span>
          <div class="setting-hint">
            {#if _biometricSupported}
              Use fingerprint or face unlock instead of typing your password each time. Your password is still required on the first sign-in. Sign-in sessions stay valid for up to a year by default — admins can change this in <strong>Settings → Users → Session Duration</strong>.
            {:else}
              Set up a fingerprint or face unlock in <strong>Android Settings → Security</strong> first, then come back here.
            {/if}
          </div>
        </div>
        <Toggle checked={$biometricLoginEnabled} on:change={onBiometricToggle} disabled={!_biometricSupported} />
      </div>
    </div>
    {/if}

    <!-- Log Out — only when there's a real session (multi-user / server mode).
         Single-user / native standalone has no session to log out of. -->
    {#if !_isLocal && $userMgmtActive}
    <div class="card">
      <button class="security-row" on:click={doLogout} disabled={loggingOut}>
        <span class="material-symbols-rounded security-icon">logout</span>
        <span class="security-label">{loggingOut ? 'Signing out…' : 'Log Out'}</span>
        <span class="material-symbols-rounded security-chev">chevron_right</span>
      </button>
    </div>
    {/if}

    <!-- Danger zone: delete my account (server mode only — local users
         use Settings → Backup & Restore → Clear all data instead) -->
    {#if !_isLocal}
    <div class="section-label" style="color:var(--danger)">{$_('profile.danger_zone')}</div>
    <div class="card danger-zone-card">
      <p class="setting-hint" style="margin:0 0 10px;line-height:1.5">
        {$_('profile.delete_account_explainer')}
      </p>
      <button class="btn btn-secondary danger-zone-btn"
        on:click={deleteMyAccount} disabled={deletingAccount}>
        <span class="material-symbols-rounded" style="font-size:18px">delete</span>
        <span>{deletingAccount ? $_('profile.deleting') : $_('profile.delete_account')}</span>
      </button>
    </div>
    {/if}
  </div>
</div>

<style>
  .page { min-height: 100dvh; background: var(--bg); padding-bottom: calc(var(--nav-h) + var(--safe-bottom) + var(--mini-player-h, 0px) + 16px); }

  /* OIDC linked accounts */
  .oidc-link-list { display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px; }
  /* Row sits inside the section card; no nested border (was visually
     competing with the outer card and clipping the meta line). */
  .oidc-link-row {
    display: flex; align-items: center; gap: 12px;
    padding: 10px 4px;
    border-bottom: 1px solid var(--border);
  }
  .oidc-link-row:last-child { border-bottom: none; }
  .oidc-link-logo { width: 24px; height: 24px; object-fit: contain; flex: 0 0 auto; }
  .oidc-link-icon { font-size: 24px; flex: 0 0 auto; color: var(--text-3); }
  .oidc-link-info { flex: 1; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .oidc-link-name { font-weight: 600; font-size: 14px; line-height: 1.3; }
  .oidc-link-meta { font-size: 11px; color: var(--text-3); line-height: 1.3; }
  .oidc-link-empty { font-size: 13px; color: var(--text-3); margin: 0 0 8px; }
  .oidc-link-add { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }
  .oidc-link-add .btn { display: flex; align-items: center; gap: 8px; justify-content: center; }

  /* page-header styled globally in base.css */
  .back-btn { background: none; border: none; cursor: pointer; color: var(--text-2); padding: 6px; border-radius: var(--radius-sm); display: flex; }
  .save-btn { height: 36px; font-size: 13px; }

  .page-content { padding: 16px var(--page-px); }
  /* Embedded mode strips the outer chrome — no standalone header, no
     page-level padding. Settings shell (or the desktop welcome hero
     inside it) already provides both. */
  .profile-embedded .page-content { padding: 8px 0 0 0; }
  .profile-embedded-save {
    display: flex;
    justify-content: flex-end;
    margin-bottom: 12px;
  }

  /* Avatar */
  .avatar-section { display: flex; flex-direction: column; align-items: center; gap: 8px; margin-bottom: 20px; }
  .avatar-wrap {
    width: 96px; height: 96px; border-radius: 50%;
    background: linear-gradient(135deg, var(--accent), var(--accent-2));
    display: flex; align-items: center; justify-content: center;
    position: relative; cursor: pointer; overflow: hidden;
  }
  .avatar-img { width: 100%; height: 100%; object-fit: cover; }
  .avatar-initial { font-size: 36px; font-weight: 800; color: var(--accent-text, #fff); }
  .avatar-overlay {
    position: absolute; inset: 0;
    background: rgba(0,0,0,0.4);
    display: flex; align-items: center; justify-content: center;
    color: #fff; opacity: 0;
    transition: opacity var(--dur-fast);
  }
  .avatar-wrap:hover .avatar-overlay { opacity: 1; }
  .avatar-name { font-size: 16px; font-weight: 600; color: var(--text-1); }

  .section-label {
    font-size: 11px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.06em; color: var(--text-3);
    padding: 4px 2px 6px; margin-top: 8px;
  }

  /* Log Out row — borrows the danger-row look but neutral coloring. */
  .security-row {
    display: flex; align-items: center; gap: 12px;
    width: 100%; padding: 4px 0;
    background: none; border: none; cursor: pointer;
    color: var(--text-1); font: inherit; text-align: left;
  }
  .security-row:hover .security-label { color: var(--accent); }
  .security-row[disabled] { opacity: 0.5; cursor: not-allowed; }
  .security-icon { color: var(--text-3); }
  .security-label { flex: 1; font-size: 14px; font-weight: 600; }
  .security-chev { color: var(--text-3); font-size: 18px; }

  .card {
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: var(--radius-lg); padding: 16px;
    display: flex; flex-direction: column; gap: 16px;
    margin-bottom: 16px;
  }

  .form-group { display: flex; flex-direction: column; gap: 6px; }
  .form-label { font-size: 13px; font-weight: 600; color: var(--text-2); }
  .height-row { display: flex; align-items: center; gap: 8px; }
  .height-narrow { flex: 0 0 80px; }
  .height-unit { font-size: 13px; color: var(--text-3); min-width: 24px; }

  .form-input, .form-select {
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-md); padding: 10px 14px;
    color: var(--text-1); font-size: 14px; font-family: inherit;
    outline: none; transition: border-color var(--dur-fast);
  }
  .form-input:focus { border-color: var(--accent); }
  .form-error { font-size: 12px; color: var(--danger); }

  .pw-strength { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
  .pw-bar { flex: 1; height: 4px; background: var(--surface-2); border-radius: var(--radius-full); overflow: hidden; }
  .pw-fill { height: 100%; border-radius: var(--radius-full); transition: width var(--dur-base), background var(--dur-fast); }
  .pw-strength.s-0 .pw-fill, .pw-strength.s-1 .pw-fill { background: var(--danger); }
  .pw-strength.s-2 .pw-fill { background: #f59e0b; }
  .pw-strength.s-3 .pw-fill { background: var(--accent); }
  .pw-strength.s-4 .pw-fill { background: var(--success); }
  .pw-label { font-size: 11px; font-weight: 600; color: var(--text-3); min-width: 64px; text-align: right; }

  .pw-wrap { position: relative; display: flex; }
  .pw-wrap .form-input { flex: 1; padding-right: 44px; }
  .pw-toggle {
    position: absolute; right: 4px; top: 50%; transform: translateY(-50%);
    background: none; border: none; cursor: pointer; color: var(--text-3);
    padding: 6px; display: flex; border-radius: var(--radius-sm);
  }
  .pw-toggle:hover { color: var(--text-1); }

  .change-pw-btn { width: 100%; height: 40px; font-size: 14px; margin-top: 4px; }
  .danger-zone-card { border-color: color-mix(in srgb, var(--danger) 25%, transparent) !important; }

  /* Danger zone button — full width, danger-tinted, icon + label centered. */
  .danger-zone-btn {
    display: flex; align-items: center; justify-content: center; gap: 8px;
    width: 100%;
    color: var(--danger);
    border-color: color-mix(in srgb, var(--danger) 40%, transparent);
  }
  .danger-zone-btn:hover {
    background: color-mix(in srgb, var(--danger) 8%, transparent);
  }
</style>
