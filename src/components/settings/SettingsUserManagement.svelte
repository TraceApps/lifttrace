<script>
  import { slide } from 'svelte/transition';
  import { _ } from 'svelte-i18n';
  import { push } from 'svelte-spa-router';
  import { currentUser, userMgmtActive, loadAuthState } from '../../stores/auth.js';
  import { resolveAssetUrl } from '../../lib/platform.js';
  import { showSuccess, showError } from '../../stores/toast.js';
  import { LtApi } from '../../lib/api.js';
  import { confirmDialog } from '../../stores/confirmDialog.js';
  import { validatePassword } from '../../lib/validation.js';
  import { DB } from '../../lib/db.js';
  import Toggle from './Toggle.svelte';


  export let expanded = false;
  export let visible = true;
  export let onToggle = () => {};

  let userList = [];
  let inviteEmail = '';
  let inviteRole = 'member';
  let inviteResult = null;
  let inviting = false;
  let pendingInvites = []; // { token, email, role, expires_at }

  // Permissive email shape — server is the source of truth, this is just
  // a UI guard so 'asdf' can't be submitted as if it were an email address.
  $: _inviteEmailTrimmed = inviteEmail.trim();
  $: _inviteEmailValid   = !_inviteEmailTrimmed || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(_inviteEmailTrimmed);
  $: _inviteCanSubmit    = !inviting && _inviteEmailValid;
  let addUsername = '';
  let addPassword = '';
  let addFullName = '';
  let addRole = 'member';
  let adding = false;
  let sessionHours = '8760';
  let sessionSaved = false;

  // Password Policy (admin-only) — 'standard' | 'strong'
  let passwordPolicy = 'standard';
  let passwordPolicySaved = false;
  // Password visibility toggles for enable-UM + add-user forms
  let enableShowPass = false;
  let addShowPass = false;
  let showAddUser = false;

  let showEnableUm = false;
  let enableAdminUser = '';
  let enableAdminName = '';
  let enableAdminPass = '';
  let enableAdminConf = '';
  let enableUmError = '';
  let enableUmLoading = false;

  // Only admins can list users / read app config — members just get the
  // "My Profile" shortcut, so skip the fetch for them.
  $: if (expanded && $userMgmtActive && $currentUser?.role === 'admin') loadUsers();
  $: trainers = userList.filter(u => u.role === 'trainer' || u.role === 'admin');

  async function loadUsers() {
    try { userList = await fetch('/api/auth/users', { credentials: 'include' }).then(r => r.json()); } catch {}
    try {
      const cfg = await fetch('/api/app-config', { credentials: 'include' }).then(r => r.json());
      sessionHours = cfg.session_hours || '8760';
      passwordPolicy = cfg.password_policy || 'standard';
    } catch {}
    await loadPendingInvites();
    // OIDC providers + password-login toggle live in SettingsAuth.svelte (own
    // top-level Authentication section under Settings → Admin).
  }

  async function loadPendingInvites() {
    try {
      const res = await fetch('/api/auth/invites', { credentials: 'include' });
      pendingInvites = res.ok ? await res.json() : [];
    } catch { pendingInvites = []; }
  }

  async function revokeInvite(token) {
    if (!await confirmDialog({
      title: $_('settings.users.revoke_invite_title'),
      message: $_('settings.users.revoke_invite_message', { default: "The link will stop working immediately. The recipient won't be able to use it after this." }),
      confirmText: $_('settings.users.revoke_confirm'),
      dangerous: true,
    })) return;
    try {
      const res = await fetch(`/api/auth/invites/${token}`, { method: 'DELETE', credentials: 'include' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        showError(data.error || $_('settings.users.err_could_not_revoke'));
        return;
      }
      await loadPendingInvites();
      showSuccess($_('settings.users.invite_revoked'));
    } catch (e) { showError(e.message || $_('settings.users.err_could_not_revoke')); }
  }

  async function deleteUser(id) {
    if (!await confirmDialog({ title: $_('settings.users.delete_user_title'), message: $_('settings.users.delete_user_message'), confirmText: $_('settings.users.delete'), dangerous: true })) return;
    await fetch(`/api/auth/users/${id}`, { method: 'DELETE', credentials: 'include' });
    await loadUsers();
  }

  async function resetUserPassword(u) {
    const name = u.full_name || u.username;
    const pw = prompt($_('settings.users.reset_password_prompt', { values: { name } }));
    if (!pw) return;
    const pwErr = validatePassword(pw);
    if (pwErr) { showError(pwErr); return; }
    try {
      const res = await fetch(`/api/auth/users/${u.id}/password`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ new_password: pw }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { showError(data?.error || $_('settings.users.err_could_not_reset_password')); return; }
      showSuccess($_('settings.users.toast_password_reset'));
    } catch (e) { showError($_('settings.users.err_could_not_reach_server')); }
  }

  async function changeUserRole(u, newRole) {
    if (newRole === u.role) return;
    const name = u.full_name || u.username;
    try {
      await LtApi.setUserRole(u.id, newRole);
      showSuccess($_('settings.users.toast_role_changed', { values: { name, role: newRole } }));
      await loadUsers();
    } catch(e) { showError(e.message); }
  }

  async function changeUserTrainer(u, newTrainerId) {
    const val = newTrainerId === '' ? null : parseInt(newTrainerId);
    if (val === (u.trainer_id ?? null)) return;
    try {
      await LtApi.setUserTrainer(u.id, val);
      showSuccess(val ? $_('settings.users.trainer_assigned') : $_('settings.users.trainer_removed'));
      await loadUsers();
    } catch(e) { showError(e.message); }
  }

  async function inviteUser() {
    if (!_inviteEmailValid) {
      showError($_('settings.users.err_invite_email'));
      return;
    }
    inviting = true; inviteResult = null;
    try {
      const res = await fetch('/api/auth/invite', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: _inviteEmailTrimmed || undefined, role: inviteRole }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { showError(data.error || $_('settings.users.err_failed_create_invite')); return; }
      inviteResult = data;
      if (data.sent) showSuccess($_('settings.users.invite_sent_to', { values: { email: _inviteEmailTrimmed } }));
      inviteEmail = '';
      await loadPendingInvites();
    } catch(e) {
      showError(e.message || $_('settings.users.err_could_not_create_invite'));
    } finally {
      // Always release the loading state — was leaking on early-returns
      // (validation fails / non-OK response) so the button stayed stuck on
      // "Sending…" until the user navigated away and back.
      inviting = false;
    }
  }

  async function addUser() {
    adding = true;
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: addUsername, password: addPassword, full_name: addFullName, role: addRole }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      showSuccess($_('settings.users.user_created'));
      addUsername = ''; addPassword = ''; addFullName = ''; addRole = 'member';
      showAddUser = false;
      await loadUsers();
    } catch(e) { showError(e.message); }
    adding = false;
  }

  async function saveSessionHours() {
    try {
      await fetch('/api/app-config', {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'session_hours', value: sessionHours }),
      });
      sessionSaved = true;
      setTimeout(() => sessionSaved = false, 2000);
    } catch(e) { showError(e.message); }
  }

  async function savePasswordPolicy(value) {
    const prev = passwordPolicy;
    passwordPolicy = value;
    try {
      const res = await fetch('/api/app-config', {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'password_policy', value }),
      });
      if (!res.ok) {
        // Most likely cause: the server hasn't redeployed with
        // 'password_policy' in ALLOWED_KEYS yet (returns 400 'Unknown
        // config key'). Roll back the optimistic UI flip and surface
        // the reason so the failure isn't silent.
        const data = await res.json().catch(() => ({}));
        const msg = data.error || $_('settings.users.save_failed_status', { values: { status: res.status } });
        console.warn('[password-policy] save rejected:', msg);
        showError($_('settings.users.err_password_policy_prefix', { values: { msg } }));
        passwordPolicy = prev;
        return;
      }
      // Confirm by reading back what the server stored — guards against
      // 'silent success' where the server returned 200 but the row didn't
      // actually persist for some reason.
      await loadUsers();
      passwordPolicySaved = true;
      setTimeout(() => passwordPolicySaved = false, 2000);
    } catch (e) {
      console.warn('[password-policy] save threw:', e);
      showError($_('settings.users.err_password_policy', { values: { msg: e?.message || $_('settings.users.network_error') } }));
      passwordPolicy = prev;
    }
  }

  async function disableUserMgmt() {
    if (!await confirmDialog({ title: $_('settings.users.disable_um_title'), message: $_('settings.users.disable_um_message'), confirmText: $_('settings.users.disable_um_confirm'), dangerous: true })) return;
    // Snapshot the current admin's profile + per-user settings BEFORE the
    // server wipes the users table — once disabled, we drop back to the
    // anonymous `wl_<key>` prefix and the synthetic LOCAL_USER. Without
    // this, the admin's name / dob / gender / avatar / settings would
    // silently disappear with no recovery path.
    const u = $currentUser;
    const oldId = u?.id;
    if (u) {
      if (u.full_name)  DB.setSetting('localUserName',     u.full_name);
      if (u.nickname)   DB.setSetting('localUserNickname', u.nickname);
      if (u.birthday)   DB.setSetting('dob',               u.birthday);
      if (u.gender)     DB.setSetting('gender',            u.gender);
      if (u.avatar_url) DB.setSetting('localUserAvatar',   u.avatar_url);
    }
    await fetch('/api/auth/management', { method: 'DELETE', credentials: 'include' });
    if (oldId != null) {
      try { DB.migrateSettingsPrefix(oldId, null); } catch {}
    }
    location.reload();
  }

  async function enableUserMgmt() {
    enableUmError = '';
    if (!enableAdminUser.trim()) { enableUmError = 'Username required'; return; }
    const pwErr = validatePassword(enableAdminPass);
    if (pwErr) { enableUmError = pwErr; return; }
    if (enableAdminPass !== enableAdminConf) { enableUmError = 'Passwords do not match'; return; }
    enableUmLoading = true;
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: enableAdminUser.trim(),
          password: enableAdminPass,
          full_name: enableAdminName.trim() || undefined,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      const { user } = await res.json();
      // Migrate previously-anonymous settings (`wl_<key>`) to the new admin's
      // per-user prefix BEFORE flipping wl:userId, so the wizard-configured
      // weightUnit / mealNames / etc. survive the mode switch.
      try { DB.migrateSettingsPrefix(null, user.id); } catch {}
      localStorage.setItem('wl:userId', String(user.id));
      // Persist any localUser* profile fields onto the admin's users-row so
      // they don't get re-discovered as null on next loadAuthState.
      const profile = {
        full_name: DB.getSetting('localUserName',     null) || enableAdminName.trim() || undefined,
        nickname:  DB.getSetting('localUserNickname', null) || undefined,
        birthday:  DB.getSetting('dob',               null) || undefined,
        gender:    DB.getSetting('gender',            null) || undefined,
        avatar_url:DB.getSetting('localUserAvatar',   null) || undefined,
      };
      if (Object.values(profile).some(v => v != null)) {
        try {
          await fetch('/api/auth/profile', {
            method: 'PUT', credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(profile),
          });
        } catch {}
      }
      await loadAuthState();
      showEnableUm = false;
      enableAdminUser = ''; enableAdminPass = ''; enableAdminConf = ''; enableAdminName = '';
      await loadUsers();
      showSuccess($_('settings.users.toast_um_enabled'));
    } catch(e) {
      enableUmError = e.message;
    }
    enableUmLoading = false;
  }

  function copyInviteUrl() {
    if (inviteResult?.inviteUrl) {
      navigator.clipboard.writeText(inviteResult.inviteUrl).then(() => showSuccess($_('settings.users.toast_link_copied')));
    }
  }
</script>

{#if visible}
  <button class="section-toggle" on:click={onToggle}>
    <span class="si"><span class="material-symbols-rounded">group</span></span>
    <span class="section-name">{$_('settings.users.section')}</span>
    <span class="material-symbols-rounded chevron" class:rotated={expanded}>expand_more</span>
  </button>
  {#if expanded}
    <div class="section-body" transition:slide={{ duration: 180 }}>
      {#if $userMgmtActive && $currentUser}
        <div class="card" style="margin-bottom:12px">
          <button class="my-profile-row" on:click={() => push('/profile')}>
            <div class="my-profile-avatar">
              {#if $currentUser.avatar_url}
                <img src={resolveAssetUrl($currentUser.avatar_url)} alt="" />
              {:else}
                {($currentUser.full_name || $currentUser.username || '?')[0].toUpperCase()}
              {/if}
            </div>
            <div class="my-profile-info">
              <span class="my-profile-name">{$currentUser.full_name || $currentUser.username}</span>
              <span class="my-profile-role">{$currentUser.role}</span>
            </div>
            <span class="material-symbols-rounded my-profile-chev">chevron_right</span>
          </button>
        </div>
      {/if}

      {#if $userMgmtActive && $currentUser?.role === 'admin'}
        <div class="card">
          <!-- User list — hidden when there's only the admin viewing
               themselves; the profile shortcut card above already represents
               that user. The list earns its keep with ≥2 users. -->
          {#if userList.length > 1}
            <div class="setting-row">
              <span class="setting-label" style="font-weight:700">{$_('settings.users.users_heading')}</span>
            </div>
            {#each userList as u (u.id)}
              <div class="user-row-mgmt">
                <div class="user-row-avatar">
                  {(u.full_name || u.username || '?')[0].toUpperCase()}
                </div>
                <div class="user-row-info">
                  <span class="user-row-name">{u.full_name || u.username}</span>
                  <span class="user-row-meta">@{u.username}</span>
                  <div class="user-row-selects">
                    {#if u.id === $currentUser.id}
                      <span class="user-role-badge">{u.role} (you)</span>
                    {:else}
                      <select class="form-select-xs" value={u.role} on:change={e => changeUserRole(u, e.target.value)} title="Role">
                        <option value="member">{$_('settings.users.role_member_opt')}</option>
                        <option value="trainer">{$_('settings.users.role_trainer_opt')}</option>
                        <option value="admin">{$_('settings.users.role_admin_opt')}</option>
                      </select>
                    {/if}
                    {#if u.role === 'member' && u.id !== $currentUser.id}
                      <select class="form-select-xs" value={u.trainer_id || ''} on:change={e => changeUserTrainer(u, e.target.value)} title="Assigned trainer">
                        <option value="">{$_('settings.users.no_trainer')}</option>
                        {#each trainers as t (t.id)}
                          <option value={t.id}>Coach {t.full_name || t.username}</option>
                        {/each}
                      </select>
                    {/if}
                  </div>
                </div>
                {#if u.id !== $currentUser.id}
                  <button class="btn-icon-danger" on:click={() => resetUserPassword(u)} title="Reset Password" style="color:var(--text-3)">
                    <span class="material-symbols-rounded" style="font-size:20px">lock_reset</span>
                  </button>
                  <button class="btn-icon-danger" on:click={() => deleteUser(u.id)} title="Delete User">
                    <span class="material-symbols-rounded" style="font-size:20px">delete</span>
                  </button>
                {/if}
              </div>
            {/each}
            <div class="setting-divider"></div>
          {/if}
          <!-- Primary path: invite -->
          <div class="um-form-block">
            <div>
              <span class="setting-label" style="font-weight:700">{$_('settings.users.invite_user')}</span>
              <div class="setting-hint" style="margin-top:2px">{$_('settings.users.invite_user_explainer')}</div>
            </div>
            <input class="form-input-sm" style="width:100%" type="email" autocomplete="email" autocapitalize="off"
              class:invalid={_inviteEmailTrimmed && !_inviteEmailValid}
              bind:value={inviteEmail} placeholder={$_('settings.users.email_optional')} />
            {#if _inviteEmailTrimmed && !_inviteEmailValid}
              <p class="invite-hint">Enter a valid email address, or clear the field to generate a shareable link.</p>
            {/if}
            <div class="um-role-pair">
              <label class="um-role-label" for="invite-role-sel">{$_('settings.users.role')}</label>
              <div class="um-role-select-wrap">
                <select id="invite-role-sel" class="um-role-styled-select" bind:value={inviteRole}>
                  <option value="member">{$_('settings.users.role_member')}</option>
                  <option value="trainer">{$_('settings.users.role_trainer')}</option>
                  <option value="admin">{$_('settings.users.role_admin')}</option>
                </select>
                <span class="material-symbols-rounded um-role-chev">expand_more</span>
              </div>
            </div>
            <button class="btn btn-primary" style="height:36px;font-size:13px" on:click={inviteUser} disabled={!_inviteCanSubmit}>
              {inviting ? $_('settings.users.sending') : (_inviteEmailTrimmed ? $_('settings.users.send_invite') : 'Generate Invite Link')}
            </button>
            {#if pendingInvites.length > 0}
              <div class="pending-invites" transition:slide={{ duration: 160 }}>
                <div class="pending-invites-label">{$_('settings.users.pending_invites')}</div>
                {#each pendingInvites as inv (inv.token)}
                  <div class="pending-invite-row">
                    <div class="pending-invite-info">
                      <span class="pending-invite-email">{inv.email || 'Link-only (no email)'}</span>
                      <span class="pending-invite-meta">
                        {inv.role === 'admin' ? 'Admin' : (inv.role === 'trainer' ? 'Trainer' : 'Member')} ·
                        expires {new Date(inv.expires_at).toLocaleDateString()}
                      </span>
                    </div>
                    <button class="pending-invite-revoke" on:click={() => revokeInvite(inv.token)}
                      aria-label="Revoke invite" title="Revoke invite">
                      <span class="material-symbols-rounded">close</span>
                    </button>
                  </div>
                {/each}
              </div>
            {/if}
            {#if inviteResult}
              <div class="invite-result">
                {#if inviteResult.sent}
                  <span class="material-symbols-rounded" style="font-size:16px;color:var(--success)">check_circle</span>
                  <span>{$_('settings.users.invite_sent_to', { values: { email: inviteEmail || $_('settings.users.user_fallback') } })}</span>
                {:else}
                  <span class="setting-hint" style="margin:0">{$_('settings.users.share_link_intro')}</span>
                  <div class="invite-link-row">
                    <input class="form-input-sm" style="flex:1;font-size:11px" type="text" value={inviteResult.inviteUrl} readonly />
                    <button class="btn btn-secondary" style="height:32px;font-size:12px" on:click={copyInviteUrl}>{$_('settings.users.copy')}</button>
                  </div>
                {/if}
              </div>
            {/if}
          </div>

          <!-- Subtle divider separating the two add-user paths -->
          <div class="setting-divider"></div>

          <!-- Secondary path: add user manually (escape hatch for no-SMTP / offline) -->
          <button class="um-secondary-toggle" on:click={() => showAddUser = !showAddUser}>
            <span class="material-symbols-rounded" style="font-size:14px">{showAddUser ? 'expand_less' : 'expand_more'}</span>
            {showAddUser ? $_('settings.users.add_user_hide') : $_('settings.users.add_user_show')}
          </button>
          {#if showAddUser}
            <div class="um-form-block" transition:slide={{ duration: 160 }}>
              <input class="form-input-sm" style="width:100%" type="text" bind:value={addUsername} placeholder={$_('settings.users.username_required')} />
              <input class="form-input-sm" style="width:100%" type="text" bind:value={addFullName} placeholder={$_('settings.users.full_name')} />
              <div class="um-pw-wrap">
                {#if addShowPass}
                  <input class="form-input-sm um-pw-input" type="text" bind:value={addPassword} placeholder={$_('settings.users.password_required')} autocomplete="new-password" passwordrules="minlength: 8; required: upper; required: lower; required: digit; required: special;" />
                {:else}
                  <input class="form-input-sm um-pw-input" type="password" bind:value={addPassword} placeholder={$_('settings.users.password_required')} autocomplete="new-password" passwordrules="minlength: 8; required: upper; required: lower; required: digit; required: special;" />
                {/if}
                <button class="um-pw-eye" type="button" on:click={() => addShowPass = !addShowPass} aria-label={addShowPass ? 'Hide' : 'Show'}>
                  <span class="material-symbols-rounded">{addShowPass ? 'visibility_off' : 'visibility'}</span>
                </button>
              </div>
              <div class="um-role-pair">
                <label class="um-role-label" for="add-role-sel">{$_('settings.users.role')}</label>
                <div class="um-role-select-wrap">
                  <select id="add-role-sel" class="um-role-styled-select" bind:value={addRole}>
                    <option value="member">{$_('settings.users.role_member')}</option>
                    <option value="trainer">{$_('settings.users.role_trainer')}</option>
                    <option value="admin">{$_('settings.users.role_admin')}</option>
                  </select>
                  <span class="material-symbols-rounded um-role-chev">expand_more</span>
                </div>
              </div>
              <button class="btn btn-secondary" style="width:100%;height:36px;font-size:13px" on:click={addUser} disabled={adding || !addUsername || !addPassword}>
                {adding ? $_('settings.users.creating') : $_('settings.users.create_directly')}
              </button>
            </div>
          {/if}
          <div class="setting-divider"></div>
          <div class="setting-row">
            <div>
              <span class="setting-label">{$_('settings.users.strong_passwords')}</span>
              <div class="setting-desc">Reject weak passwords (zxcvbn score below 3) on top of the standard 8-char + mixed-case + number + symbol rules. Affects new sign-ups, invites, and password changes. Existing passwords aren't re-checked.</div>
            </div>
            <Toggle checked={passwordPolicy === 'strong'} on:change={e => savePasswordPolicy(e.detail ? 'strong' : 'standard')} />
          </div>
          {#if passwordPolicySaved}
            <p class="setting-desc" style="padding:0 16px 8px;color:var(--accent)">Saved.</p>
          {/if}

          <div class="setting-divider"></div>
          <div class="setting-row">
            <span class="setting-label">{$_('settings.users.session_duration')}</span>
            <div style="display:flex;gap:8px;align-items:center">
              <select class="form-select-sm" bind:value={sessionHours}>
                <option value="0">{$_('settings.users.session_never')}</option>
                <option value="8">{$_('settings.users.session_8h')}</option>
                <option value="24">{$_('settings.users.session_1d')}</option>
                <option value="168">{$_('settings.users.session_7d')}</option>
                <option value="720">{$_('settings.users.session_30d')}</option>
                <option value="2160">{$_('settings.users.session_90d')}</option>
                <option value="8760">{$_('settings.users.session_1y')}</option>
              </select>
              <button class="btn btn-secondary" style="height:32px;font-size:12px;min-width:54px" on:click={saveSessionHours}>
                {#if sessionSaved}<span class="material-symbols-rounded" style="font-size:14px">check</span>{:else}{$_('settings.users.save')}{/if}
              </button>
            </div>
          </div>


          <div class="setting-divider"></div>
          <button class="row-btn danger-row" on:click={disableUserMgmt}>
            <div class="setting-label-group">
              <span class="setting-label">{$_('settings.users.disable_um')}</span>
              <span class="setting-hint">{$_('settings.users.disable_um_hint')}</span>
            </div>
            <span class="material-symbols-rounded">dangerous</span>
          </button>
        </div>

      {:else if !$userMgmtActive}
        <div class="card">
          {#if showEnableUm}
            <div style="padding:14px 16px;display:flex;flex-direction:column;gap:12px">
              <span class="setting-label" style="font-weight:700">{$_('settings.users.create_admin_account')}</span>
              <span class="setting-desc" style="margin:0">{$_('settings.users.create_admin_explainer')}</span>
              <input class="form-input-sm" style="width:100%" type="text" bind:value={enableAdminUser} placeholder={$_('settings.users.username_required')} />
              <input class="form-input-sm" style="width:100%" type="text" bind:value={enableAdminName} placeholder={$_('settings.users.full_name')} />
              <div style="display:flex;gap:6px;align-items:center">
                {#if enableShowPass}
                  <input class="form-input-sm" style="flex:1" type="text" bind:value={enableAdminPass} placeholder={$_('settings.users.password_required')} autocomplete="new-password" passwordrules="minlength: 8; required: upper; required: lower; required: digit; required: special;" />
                {:else}
                  <input class="form-input-sm" style="flex:1" type="password" bind:value={enableAdminPass} placeholder={$_('settings.users.password_required')} autocomplete="new-password" passwordrules="minlength: 8; required: upper; required: lower; required: digit; required: special;" />
                {/if}
                <button class="btn-icon" type="button" on:click={() => enableShowPass = !enableShowPass} title={enableShowPass ? $_('settings.users.hide') : $_('settings.users.show')} style="flex-shrink:0">
                  <span class="material-symbols-rounded" style="font-size:18px">{enableShowPass ? 'visibility_off' : 'visibility'}</span>
                </button>
              </div>
              {#if enableShowPass}
                <input class="form-input-sm" style="width:100%" type="text" bind:value={enableAdminConf} placeholder={$_('settings.users.confirm_password_ph')} autocomplete="new-password" passwordrules="minlength: 8; required: upper; required: lower; required: digit; required: special;" />
              {:else}
                <input class="form-input-sm" style="width:100%" type="password" bind:value={enableAdminConf} placeholder={$_('settings.users.confirm_password_ph')} autocomplete="new-password" passwordrules="minlength: 8; required: upper; required: lower; required: digit; required: special;" />
              {/if}
              {#if enableUmError}
                <span class="form-error" style="font-size:12px;color:var(--danger)">{enableUmError}</span>
              {/if}
              <div style="display:flex;gap:8px">
                <button class="btn btn-primary" style="flex:1;height:36px;font-size:13px" on:click={enableUserMgmt} disabled={enableUmLoading}>
                  {enableUmLoading ? $_('settings.users.enabling') : $_('settings.users.enable_create')}
                </button>
                <button class="btn btn-secondary" style="height:36px;font-size:13px" on:click={() => showEnableUm = false}>{$_('settings.users.cancel')}</button>
              </div>
            </div>
          {:else}
            <div class="setting-row">
              <div class="setting-label-group">
                <span class="setting-label">{$_('settings.users.enable_um')}</span>
                <span class="setting-hint">{$_('settings.users.enable_um_subtitle')}</span>
              </div>
              <button class="btn btn-primary" style="height:36px;font-size:13px" on:click={() => showEnableUm = true}>
                {$_('settings.users.enable_um_setup')}
              </button>
            </div>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
{/if}

<style>
  /* My Profile shortcut (top of the User Management section) */
  .my-profile-row {
    display: flex; align-items: center; gap: 14px;
    width: 100%; padding: 14px 16px;
    background: none; border: none; cursor: pointer;
    font-family: inherit; text-align: left;
    transition: background var(--dur-fast);
  }
  .my-profile-row:hover { background: var(--surface-2); }
  .my-profile-avatar {
    width: 44px; height: 44px; border-radius: 50%;
    background: linear-gradient(135deg, var(--accent), var(--accent-2, var(--accent)));
    color: #fff;
    font-size: 18px; font-weight: 800;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0; overflow: hidden;
  }
  .my-profile-avatar img { width: 100%; height: 100%; object-fit: cover; }
  .my-profile-info { flex: 1; display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  .my-profile-name { font-size: 15px; font-weight: 700; color: var(--text-1); }
  .my-profile-role {
    font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--accent); background: var(--accent-dim);
    padding: 2px 8px; border-radius: var(--radius-full);
    align-self: flex-start;
  }
  .my-profile-chev { color: var(--text-3); }

  .user-row-mgmt {
    display: flex; align-items: center; gap: 12px;
    padding: 10px 16px;
    border-bottom: 1px solid var(--border);
  }
  .user-row-mgmt:last-child { border-bottom: none; }
  .user-row-avatar {
    width: 36px; height: 36px; border-radius: 50%;
    background: var(--accent-dim); color: var(--accent);
    font-size: 15px; font-weight: 700;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
  }
  .user-row-info { flex: 1; display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  .user-row-name { font-size: 14px; font-weight: 600; color: var(--text-1); }
  .user-row-meta { font-size: 12px; color: var(--text-3); }
  .user-row-selects { display: flex; gap: 6px; margin-top: 4px; flex-wrap: wrap; }
  .user-role-badge {
    font-size: 11px; font-weight: 600; color: var(--text-3);
    background: var(--surface-2); padding: 3px 8px; border-radius: var(--radius-sm);
    text-transform: capitalize;
  }
  .form-select-xs {
    background: var(--surface-2); border: 1px solid var(--border);
    color: var(--text-1); font-size: 11px; font-family: inherit;
    border-radius: var(--radius-sm); padding: 3px 6px; height: 24px;
    outline: none; cursor: pointer;
  }
  .form-select-xs:focus { border-color: var(--accent); }

  .invite-result {
    display: flex; flex-direction: column; gap: 8px;
    padding: 10px 0 0;
  }
  .invite-link-row { display: flex; gap: 8px; align-items: center; }
  .invite-hint { font-size: 11px; color: var(--danger, #ef4444); margin: -2px 0 4px; line-height: 1.4; }
  .form-input-sm.invalid { border-color: var(--danger, #ef4444); }

  /* Pending invites — appears under the invite form whenever there are
     unused, unexpired invite tokens. Each row shows the recipient + role
     + expiry + a small revoke button. */
  .pending-invites {
    display: flex; flex-direction: column; gap: 4px;
    padding: 8px 10px;
    background: var(--surface-2); border-radius: var(--radius-md);
    margin-top: 4px;
  }
  .pending-invites-label {
    font-size: 11px; font-weight: 700; letter-spacing: 0.06em;
    text-transform: uppercase; color: var(--text-3); padding: 4px 2px;
  }
  .pending-invite-row {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 8px; border-radius: var(--radius-sm);
  }
  .pending-invite-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .pending-invite-email {
    font-size: 13px; font-weight: 500; color: var(--text-1);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .pending-invite-meta  { font-size: 11px; color: var(--text-3); }
  .pending-invite-revoke {
    background: none; border: none; cursor: pointer;
    padding: 4px; color: var(--text-3);
    display: flex; align-items: center; justify-content: center;
  }
  .pending-invite-revoke:hover { color: var(--danger, #ef4444); }
  .pending-invite-revoke .material-symbols-rounded { font-size: 18px; }

  /* Secondary 'Add user manually' toggle — quieter than a button, leads
     into the escape-hatch direct-add form. */
  .um-secondary-toggle {
    display: flex; align-items: center; gap: 4px;
    width: 100%;
    background: none; border: none; cursor: pointer;
    padding: 10px 16px;
    color: var(--text-3); font-size: 12px; font-family: inherit;
    text-align: left;
    transition: color var(--dur-fast);
  }
  .um-secondary-toggle:hover { color: var(--text-2); }

  /* Vertically-stacked form block for invite + manual-add — clearer than
     the previous side-by-side compression that squished the password
     input next to the eye icon. */
  .um-form-block {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 10px;
    padding: 12px 16px;
  }

  /* Password input + visibility toggle, side-by-side with the eye icon
     pinned at the right. The previous flex-1-on-flex-1 nesting collapsed
     the input to a stub. */
  .um-pw-wrap {
    position: relative;
    display: flex;
    align-items: center;
  }
  .um-pw-input {
    flex: 1;
    width: 100%;
    padding-right: 38px;
  }
  .um-pw-eye {
    position: absolute;
    right: 6px;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-3);
    padding: 4px;
    display: flex;
    align-items: center;
  }
  .um-pw-eye:hover { color: var(--text-1); }
  .um-pw-eye .material-symbols-rounded { font-size: 18px; }

  /* Role select with proper label + chevron — looks like a select instead
     of a flat input. */
  .um-role-pair {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .um-role-label {
    font-size: 13px;
    color: var(--text-2);
    flex-shrink: 0;
  }
  .um-role-select-wrap {
    position: relative;
    display: inline-flex;
    align-items: center;
  }
  .um-role-styled-select {
    appearance: none;
    -webkit-appearance: none;
    background: var(--surface-2);
    border: 1px solid var(--border);
    color: var(--text-1);
    font-size: 13px;
    font-family: inherit;
    border-radius: var(--radius-md);
    padding: 6px 28px 6px 10px;
    cursor: pointer;
  }
  .um-role-styled-select:focus {
    outline: none;
    border-color: var(--accent);
  }
  .um-role-chev {
    position: absolute;
    right: 6px;
    pointer-events: none;
    font-size: 18px;
    color: var(--text-3);
  }

  .btn-icon-danger {
    background: none; border: none; cursor: pointer;
    color: var(--danger); padding: 0 4px;
    display: flex; align-items: center;
  }
  .btn-icon-danger:hover { opacity: 0.7; }

  .setting-desc {
    font-size: 12px; color: var(--text-3); margin-top: 2px; font-weight: 400; line-height: 1.5;
  }

</style>
