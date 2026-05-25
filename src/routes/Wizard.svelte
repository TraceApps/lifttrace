<script>
  import { onMount } from 'svelte';
  import { push } from 'svelte-spa-router';
  import { fade, slide } from 'svelte/transition';
  import { _ } from 'svelte-i18n';
  import { DB } from '../lib/db.js';
  import { applyAppearance, applyAccentColor, loadServerSettings, bulkSet } from '../stores/settings.js';
  import { currentUser, userMgmtActive, setupRequired, loadAuthState } from '../stores/auth.js';
  import { showError, showSuccess } from '../stores/toast.js';
  import { LtApi } from '../lib/api.js';
  import { validatePassword } from '../lib/validation.js';
  import { isNative, getServerUrl } from '../lib/platform.js';
  import TraceFace from '../components/ai/TraceFace.svelte';

  // When setup_required (PWA, no users exist), force account creation — can't skip
  const forceAccountCreation = $setupRequired;
  // Native standalone mode: no auth, no server, single device. Replaces the
  // users step with a single optional name input so we can still personalize
  // the UI (Sidebar header, Trace greetings, Profile, etc.) without a full
  // user account. localUserName is read by auth.js's loadAuthState() and
  // surfaced as the synthetic LOCAL_USER's full_name.
  const _isNativeLocal = isNative && !getServerUrl();
  let localName = '';

  const STEPS = ['welcome', 'users', 'units', 'profile', 'goals', 'library', 'appearance'];
  let step = 0;

  // Step: profile (gender, dob, height, current weight) — feeds the
  // Mifflin-St Jeor BMR used by the calorie-burn estimator. All fields are
  // optional; users can skip and come back via Settings → Profile if they
  // want to enable calorie estimates later.
  let bpGender   = '';
  let bpDob      = '';
  let bpHeightFt = '';   // imperial input
  let bpHeightIn = '';   // imperial input
  let bpHeightCm = '';   // metric input
  let bpWeight   = '';   // in user's chosen weightUnit

  // Step: library
  const LICENSE_TAGS = {
    'wger':           { label: 'CC-BY-SA 4.0', note: 'Credit + share-alike' },
    'free-db':        { label: 'Public Domain', note: 'No restrictions' },
    'exercisedb':     { label: 'Commercial',    note: 'Needs RapidAPI key' },
    'exercisedb-oss': { label: 'AGPL-3.0',      note: 'Personal use, community-hosted' },
  };
  let libSources = [];
  let libSelected = new Set();  // source ids the user wants to import
  let libKeys = {};              // { 'exercisedb': 'rapidapi-key-here' }
  let libImporting = false;
  let libProgress = null;        // { id, idx, total } or null

  async function loadLibrarySources() {
    try {
      libSources = await LtApi.listExerciseSources();
      // Pre-select Free Exercise DB (public domain, safest default)
      if (libSources.some(s => s.id === 'free-db')) libSelected.add('free-db');
      libSelected = libSelected;  // trigger reactivity
    } catch(e) { libSources = []; }
  }

  async function importSelectedLibraries() {
    if (libSelected.size === 0) { step = 6; return; }
    libImporting = true;
    const ids = [...libSelected];
    let done = 0, failed = 0;
    libProgress = { id: '', idx: 0, total: ids.length };
    // Parallel with concurrency 2 \u2014 enough to speed up, not enough to
    // overload shared/rate-limited upstreams (oss.exercisedb.dev is CF'd).
    const CONCURRENCY = 2;
    let cursor = 0;
    async function worker() {
      while (cursor < ids.length) {
        const idx = cursor++;
        const id = ids[idx];
        libProgress = { id, idx: done + 1, total: ids.length };
        try {
          await LtApi.importExerciseSource(id, libKeys[id]);
          done++;
        } catch(e) {
          failed++;
          showError(`${id}: ${e.message}`);
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
    libImporting = false;
    libProgress = null;
    if (failed === 0) showSuccess($_('wizard.library.ready', { values: { n: done } }));
    else showError(`${done} imported, ${failed} failed. You can retry from Settings.`);
    step = 6;
  }

  function toggleLibSource(id) {
    if (libSelected.has(id)) libSelected.delete(id);
    else libSelected.add(id);
    libSelected = libSelected;
  }

  // Load sources the first time the wizard hits the library step
  let _libLoaded = false;
  $: if (step === 5 && !_libLoaded) { _libLoaded = true; loadLibrarySources(); }

  // Step: users — pre-enable if forced
  let enableUsers = forceAccountCreation;
  let adminUser = '';
  let adminName = '';
  let adminEmail = '';
  let adminPass = '';
  let adminConf = '';
  let umError = '';
  let umLoading = false;

  // Step: units — single 'metric' | 'imperial' choice that drives both
  // weightUnit + heightUnit + any future unit-bearing setting. Mirrors
  // NutriTrace's wizard so users only pick once.
  let unitSystem = '';
  // Derived (kept for the body-profile step's input rendering — its UI
  // branches on this rather than carrying a separate flag).
  $: weightUnit = unitSystem === 'metric' ? 'kg' : 'lbs';

  // Step: goals
  let weeklyGoal = 4;

  // Step: appearance
  let appearance = 'system';

  onMount(() => { applyAppearance('system'); });

  const _validatePw = validatePassword;

  async function nextFromUsers() {
    // PWA single-user (user opted out of multi-user) — capture the optional
    // localName they typed in below the off-toggle, mirroring native local.
    // Without this, PWA single-user finishes the wizard with no display name
    // ever set and Trace / Sidebar / Profile fall back to "Local User".
    if (!enableUsers) {
      if (localName.trim()) DB.setSetting('localUserName', localName.trim());
      step++;
      return;
    }
    umError = '';
    if (!adminUser.trim()) { umError = $_('wizard.users.errors.username_required'); return; }
    const pwErr = _validatePw(adminPass);
    if (pwErr) { umError = pwErr; return; }
    if (adminPass !== adminConf) { umError = $_('wizard.users.errors.password_mismatch'); return; }
    umLoading = true;
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: adminUser.trim(),
          password: adminPass,
          full_name: adminName.trim() || undefined,
          email: adminEmail.trim() || undefined,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      const { user, token } = await res.json();
      // Native Capacitor builds need the JWT in localStorage so apiFetch can
      // attach Authorization: Bearer; cookie alone isn't reliable on a
      // WebView across launches. Server now returns the token on first-user
      // registration; older servers omit it and the cookie path still works
      // for browser builds.
      if (token) {
        const { setAuthToken } = await import('../lib/platform.js');
        setAuthToken(token);
      }
      localStorage.setItem('wl:userId', String(user.id));
      currentUser.set(user);
      await loadAuthState();
      step++;
    } catch(e) {
      umError = e.message;
    }
    umLoading = false;
  }

  async function finish() {
    await _persistAndExit();
  }

  // Shared write path used by both finish() and skip(). Writes everything
  // collected so far through bulkSet (so SERVER_SETTINGS keys propagate to
  // the server via the existing debounce), then in server mode also pushes
  // gender/birthday to /api/auth/profile so the users-table-backed
  // $currentUser reflects what the wizard collected.
  async function _persistAndExit() {
    const isMetric = unitSystem === 'metric';
    const finalCm = isMetric
      ? (bpHeightCm ? Number(bpHeightCm) : null)
      : ((bpHeightFt || bpHeightIn) ? _ftInToCm(bpHeightFt, bpHeightIn) : null);
    const weightKg = (bpWeight && Number(bpWeight) > 0)
      ? (isMetric ? Number(bpWeight) : Number(bpWeight) * 0.45359237)
      : null;

    const batch = {
      // Always written
      setupComplete: true,
      appearance,
      // Brand-new users finishing onboarding get the gradient banner as
      // their default first impression. Existing users (who never re-run
      // the wizard) keep whatever bannerStyle / legacy pageBanners they
      // already had — the migration in settings.js handles that path.
      bannerStyle: 'gradient',
      // Unit system — driven by a single pick in step 2
      ...(unitSystem ? { weightUnit: isMetric ? 'kg' : 'lbs', heightUnit: isMetric ? 'cm' : 'ft' } : {}),
      // Goals
      ...(weeklyGoal ? { weeklyWorkoutGoal: weeklyGoal } : {}),
      // Body profile — anything blank is just skipped; estimator hides
      // itself when inputs are missing, so partial data is fine.
      ...(bpGender ? { gender: bpGender } : {}),
      ...(bpDob    ? { dob: bpDob } : {}),
      ...(finalCm  ? { heightCm: finalCm } : {}),
      ...(weightKg ? { currentWeightKg: Math.round(weightKg * 10) / 10 } : {}),
      // Local-mode personalization
      ...(_isNativeLocal && localName.trim() ? { localUserName: localName.trim() } : {}),
    };
    bulkSet(batch);

    // Server mode: push gender + birthday into the users table too, so
    // $currentUser.gender and $currentUser.birthday (the source of truth
    // Profile reads in server mode) reflect the wizard. Settings-only
    // writes don't reach those columns.
    if (!_isNativeLocal && (bpGender || bpDob)) {
      try {
        await fetch('/api/auth/profile', {
          method: 'PUT', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...(bpGender ? { gender: bpGender } : {}),
            ...(bpDob    ? { birthday: bpDob } : {}),
          }),
        });
      } catch {}
    }

    // Refresh the user store so Sidebar / Trace / Profile / etc. pick up
    // the new fields without a page reload.
    try { await loadAuthState(); } catch {}
    push('/');
  }

  // Skip the rest of the wizard from any step. Mirrors NutriTrace's
  // wizard.nav.skip — saves whatever the user has entered so far + marks
  // setup complete so the wizard doesn't re-open on next launch.
  let skipModal = false;
  async function skip() {
    if (forceAccountCreation && !$userMgmtActive) return; // PWA forced-account guard
    skipModal = false;
    await _persistAndExit();
  }

  function _ftInToCm(ft, inches) {
    const f = Number(ft) || 0;
    const i = Number(inches) || 0;
    return Math.round(((f * 12) + i) * 2.54);
  }
</script>

<div class="wizard-wrap">
  <div class="wizard-card">
    <!-- Top-bar Skip — visible past step 0, suppressed when PWA is forcing
         admin-account creation (no users yet on server, no skip allowed). -->
    {#if step > 0 && !(forceAccountCreation && !$userMgmtActive)}
      <div class="wizard-topbar">
        <button class="btn btn-ghost wizard-skip" on:click={() => skipModal = true}>
          {$_('wizard.nav.skip')}
        </button>
      </div>
    {/if}

    <!-- Step 0: Welcome -->
    {#if step === 0}
      <div class="wizard-step" in:fade>
        <div class="wizard-icon">
          <TraceFace size={48} />
        </div>
        <h1 class="wizard-title">{$_('wizard.welcome.title')}</h1>
        <p class="wizard-desc">{$_('wizard.welcome.desc')}</p>
        <button class="btn btn-primary wizard-btn" on:click={() => step = 1}>{$_('wizard.nav.get_started')}</button>
        {#if !(forceAccountCreation && !$userMgmtActive)}
          <button type="button" class="skip-setup-link" on:click={() => skipModal = true}>
            {$_('wizard.skip_modal.do_later')}
          </button>
        {/if}
      </div>

    <!-- Step 1: User management (server / PWA) OR name (native local) -->
    {:else if step === 1}
      {#if _isNativeLocal}
        <div class="wizard-step">
          <h2 class="wizard-step-title">{$_('wizard.name.title')}</h2>
          <p class="wizard-step-desc">{$_('wizard.name.desc')}</p>
          <div style="max-width:360px;margin:8px auto 0">
            <input
              class="wiz-input"
              type="text"
              placeholder={$_('wizard.name.placeholder')}
              bind:value={localName}
              autocomplete="given-name"
              style="width:100%;font-size:18px;padding:14px 16px;text-align:center" />
          </div>
          <div class="wizard-nav">
            <button class="btn btn-secondary wizard-btn-sm" on:click={() => step = 0}>{$_('wizard.nav.back')}</button>
            <button class="btn btn-primary wizard-btn-sm" on:click={() => step = 2}>{$_('wizard.nav.next')}</button>
          </div>
        </div>
      {:else}
      <div class="wizard-step">
        <h2 class="wizard-step-title">{forceAccountCreation ? $_('wizard.users.create_admin_title') : $_('wizard.users.multi_user_title')}</h2>
        {#if forceAccountCreation}
          <p class="wizard-step-desc">{$_('wizard.users.create_admin_desc')}</p>
        {:else}
          <p class="wizard-step-desc">{$_('wizard.users.multi_user_desc')}</p>
        {/if}

        {#if !forceAccountCreation}
          <div class="toggle-row">
            <span class="toggle-label">{$_('wizard.users.enable_toggle')}</span>
            <button class="toggle-pill" class:active={enableUsers} on:click={() => enableUsers = !enableUsers}>
              <span class="toggle-thumb"></span>
            </button>
          </div>
        {/if}

        {#if enableUsers}
          <div class="um-form" transition:slide={{ duration: 180 }}>
            <input class="wiz-input" type="text" bind:value={adminUser} placeholder={$_('wizard.users.username_placeholder')} />
            <input class="wiz-input" type="text" bind:value={adminName} placeholder={$_('wizard.users.fullname_placeholder')} />
            <input class="wiz-input" type="email" bind:value={adminEmail} placeholder={$_('wizard.users.email_placeholder')} />
            <input class="wiz-input" type="password" bind:value={adminPass} placeholder={$_('wizard.users.password_placeholder')} />
            <input class="wiz-input" type="password" bind:value={adminConf} placeholder={$_('wizard.users.confirm_placeholder')} />
            {#if umError}
              <span class="um-error">{umError}</span>
            {/if}
          </div>
        {:else}
          <!-- PWA single-user: still let the user pick a display name so
               Trace / Sidebar / Profile can personalize. Optional. -->
          <div class="um-form" transition:slide={{ duration: 180 }} style="max-width:360px;margin:0 auto">
            <input
              class="wiz-input"
              type="text"
              placeholder="Your name (optional)"
              bind:value={localName}
              autocomplete="given-name"
              style="text-align:center" />
          </div>
        {/if}

        <div class="wizard-nav">
          <button class="btn btn-secondary wizard-btn-sm" on:click={() => step = 0}>{$_('wizard.nav.back')}</button>
          <button class="btn btn-primary wizard-btn-sm" on:click={nextFromUsers} disabled={umLoading}>
            {umLoading ? $_('wizard.users.creating') : $_('wizard.nav.next')}
          </button>
        </div>
      </div>
      {/if}

    <!-- Step 2: Measurement system — one choice drives weight + height. -->
    {:else if step === 2}
      <div class="wizard-step">
        <h2 class="wizard-step-title">{$_('wizard.units.title')}</h2>
        <p class="wizard-step-desc">{$_('wizard.units.desc')}</p>
        <div class="unit-cards">
          <button class="unit-card" class:selected={unitSystem === 'metric'} on:click={() => unitSystem = 'metric'}>
            <span class="material-symbols-rounded unit-card-icon">straighten</span>
            <span class="unit-card-label">{$_('wizard.units.metric')}</span>
            <span class="unit-card-sub">{$_('wizard.units.metric_sub')}</span>
            {#if unitSystem === 'metric'}
              <span class="material-symbols-rounded unit-card-check">check_circle</span>
            {/if}
          </button>
          <button class="unit-card" class:selected={unitSystem === 'imperial'} on:click={() => unitSystem = 'imperial'}>
            <span class="material-symbols-rounded unit-card-icon">scale</span>
            <span class="unit-card-label">{$_('wizard.units.imperial')}</span>
            <span class="unit-card-sub">{$_('wizard.units.imperial_sub')}</span>
            {#if unitSystem === 'imperial'}
              <span class="material-symbols-rounded unit-card-check">check_circle</span>
            {/if}
          </button>
        </div>
        <div class="wizard-nav">
          <button class="btn btn-secondary wizard-btn-sm" on:click={() => step = 1}>{$_('wizard.nav.back')}</button>
          <button class="btn btn-primary wizard-btn-sm" on:click={() => step = 3} disabled={!unitSystem}>{$_('wizard.nav.next')}</button>
        </div>
      </div>

    <!-- Step 3: Profile (gender, dob, height, weight) — feeds the calorie
         estimator. All optional; users can skip and fill in later via Profile. -->
    {:else if step === 3}
      <div class="wizard-step">
        <h2 class="wizard-step-title">{$_('wizard.profile.title')}</h2>
        <p class="wizard-step-desc">{$_('wizard.profile.desc')}</p>

        <div class="bp-grid">
          <div class="bp-row">
            <label class="bp-label" for="bp-gender">{$_('wizard.profile.sex')}</label>
            <select id="bp-gender" class="bp-input" bind:value={bpGender}>
              <option value="">—</option>
              <option value="male">{$_('wizard.profile.sex_male')}</option>
              <option value="female">{$_('wizard.profile.sex_female')}</option>
              <option value="other">{$_('wizard.profile.sex_other')}</option>
            </select>
          </div>

          <div class="bp-row">
            <label class="bp-label" for="bp-dob">{$_('wizard.profile.dob')}</label>
            <input id="bp-dob" class="bp-input" type="date" bind:value={bpDob} />
          </div>

          <div class="bp-row">
            <span class="bp-label">{$_('wizard.profile.height')}</span>
            {#if weightUnit === 'kg'}
              <div class="bp-pair">
                <input class="bp-input" type="number" inputmode="numeric" min="50" max="250"
                  placeholder="cm" bind:value={bpHeightCm} />
                <span class="bp-unit">cm</span>
              </div>
            {:else}
              <div class="bp-pair">
                <input class="bp-input bp-narrow" type="number" inputmode="numeric" min="3" max="8"
                  placeholder="ft" bind:value={bpHeightFt} />
                <span class="bp-unit">ft</span>
                <input class="bp-input bp-narrow" type="number" inputmode="numeric" min="0" max="11"
                  placeholder="in" bind:value={bpHeightIn} />
                <span class="bp-unit">in</span>
              </div>
            {/if}
          </div>

          <div class="bp-row">
            <label class="bp-label" for="bp-weight">{$_('wizard.profile.weight')}</label>
            <div class="bp-pair">
              <input id="bp-weight" class="bp-input" type="number" inputmode="decimal"
                step="0.1" min="20" max="500"
                placeholder={weightUnit === 'kg' ? 'kg' : 'lbs'} bind:value={bpWeight} />
              <span class="bp-unit">{weightUnit === 'kg' ? 'kg' : 'lbs'}</span>
            </div>
          </div>
        </div>

        <p class="bp-hint">{$_('wizard.profile.hint')}</p>

        <div class="wizard-nav">
          <button class="btn btn-secondary wizard-btn-sm" on:click={() => step = 2}>{$_('wizard.nav.back')}</button>
          <button class="btn btn-secondary wizard-btn-sm" on:click={() => step = 4}>{$_('wizard.nav.skip')}</button>
          <button class="btn btn-primary wizard-btn-sm" on:click={() => step = 4}>{$_('wizard.nav.next')}</button>
        </div>
      </div>

    <!-- Step 4: Weekly goal -->
    {:else if step === 4}
      <div class="wizard-step">
        <h2 class="wizard-step-title">{$_('wizard.goals.title')}</h2>
        <p class="wizard-step-desc">{$_('wizard.goals.desc')}</p>
        <div class="goal-options">
          {#each [2,3,4,5,6,7] as n}
            <button class="goal-btn" class:active={weeklyGoal === n} on:click={() => weeklyGoal = n}>
              <span class="goal-num">{n}</span>
              <span class="goal-sub">{$_('wizard.goals.days_sub')}</span>
            </button>
          {/each}
        </div>
        <div class="wizard-nav">
          <button class="btn btn-secondary wizard-btn-sm" on:click={() => step = 3}>{$_('wizard.nav.back')}</button>
          <button class="btn btn-primary wizard-btn-sm" on:click={() => step = 5}>{$_('wizard.nav.next')}</button>
        </div>
      </div>

    <!-- Step 5: Exercise library -->
    {:else if step === 5}
      <div class="wizard-step">
        <h2 class="wizard-step-title">{$_('wizard.library.title')} <span class="wiz-optional">{$_('wizard.library.optional')}</span></h2>
        <p class="wizard-step-desc">{$_('wizard.library.desc')}</p>

        <div class="lib-list">
          {#each libSources as src (src.id)}
            {@const tag = LICENSE_TAGS[src.id] || { label: '', note: '' }}
            <!-- svelte-ignore a11y-click-events-have-key-events -->
            <!-- svelte-ignore a11y-no-static-element-interactions -->
            <div class="lib-row" class:selected={libSelected.has(src.id)} on:click={() => toggleLibSource(src.id)}>
              <div class="lib-check" class:checked={libSelected.has(src.id)}>
                {#if libSelected.has(src.id)}<span class="material-symbols-rounded">check</span>{/if}
              </div>
              <div class="lib-body">
                <div class="lib-head">
                  <span class="lib-name">{src.name}</span>
                  {#if tag.label}<span class="lib-license">{tag.label}</span>{/if}
                </div>
                <span class="lib-desc">{src.description}</span>
                {#if tag.note}<span class="lib-note">{tag.note}</span>{/if}
                {#if src.requiresKey && libSelected.has(src.id)}
                  <input
                    class="wiz-input"
                    style="margin-top:6px"
                    type="password"
                    placeholder="{src.name} API key"
                    bind:value={libKeys[src.id]}
                    on:click|stopPropagation
                  />
                {/if}
              </div>
            </div>
          {/each}
        </div>

        {#if libProgress}
          <div class="lib-progress">
            <span>{$_('wizard.library.progress', { values: { id: libProgress.id, idx: libProgress.idx, total: libProgress.total } })}</span>
          </div>
        {/if}

        <div class="wizard-nav">
          <button class="btn btn-secondary wizard-btn-sm" on:click={() => step = 4} disabled={libImporting}>{$_('wizard.nav.back')}</button>
          <button class="btn btn-secondary wizard-btn-sm" on:click={() => { libSelected.clear(); step = 6; }} disabled={libImporting}>{$_('wizard.nav.skip')}</button>
          <button class="btn btn-primary wizard-btn-sm" on:click={importSelectedLibraries} disabled={libImporting || libSelected.size === 0}>
            {libImporting ? $_('wizard.library.importing') : (libSelected.size > 0 ? $_('wizard.library.import_n', { values: { n: libSelected.size } }) : $_('wizard.nav.next'))}
          </button>
        </div>
      </div>

    <!-- Step 6: Appearance -->
    {:else if step === 6}
      <div class="wizard-step">
        <h2 class="wizard-step-title">{$_('wizard.appearance.title')}</h2>
        <p class="wizard-step-desc">{$_('wizard.appearance.desc')}</p>
        <div class="theme-options">
          {#each [['system','wizard.appearance.auto','contrast'],['dark','wizard.appearance.dark','dark_mode'],['light','wizard.appearance.light','light_mode']] as [val, labelKey, icon]}
            <button class="theme-btn" class:active={appearance === val} on:click={() => { appearance = val; applyAppearance(val); }}>
              <span class="material-symbols-rounded theme-icon">{icon}</span>
              <span>{$_(labelKey)}</span>
            </button>
          {/each}
        </div>
        <div class="wizard-nav">
          <button class="btn btn-secondary wizard-btn-sm" on:click={() => step = 5}>{$_('wizard.nav.back')}</button>
          <button class="btn btn-primary wizard-btn-sm" on:click={finish}>{$_('wizard.nav.lets_go')}</button>
        </div>
      </div>
    {/if}

    <!-- Progress dots -->
    <div class="wizard-dots">
      {#each STEPS as _, i}
        <div class="dot" class:active={step === i}></div>
      {/each}
    </div>
  </div>
</div>

{#if skipModal}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div class="skip-modal-backdrop" on:click|self={() => skipModal = false}>
    <div class="skip-modal" on:click|stopPropagation>
      <h3 class="skip-modal-title">{$_('wizard.skip_modal.title')}</h3>
      <p class="skip-modal-desc">{$_('wizard.skip_modal.desc')}</p>
      <div class="skip-modal-actions">
        <button class="btn btn-secondary" on:click={() => skipModal = false}>{$_('wizard.skip_modal.continue')}</button>
        <button class="btn btn-primary" on:click={skip}>{$_('wizard.skip_modal.skip_now')}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .wizard-wrap {
    display: flex; align-items: center; justify-content: center;
    min-height: 100dvh;
    padding: 24px 16px;
    background: var(--bg);
  }
  .wizard-card {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-xl);
    padding: 40px 32px;
    max-width: 400px;
    width: 100%;
    box-shadow: var(--shadow-lg);
    text-align: center;
  }
  .wizard-icon {
    width: 80px; height: 80px;
    border-radius: var(--radius-xl);
    background: var(--accent-dim);
    color: var(--accent);
    display: flex; align-items: center; justify-content: center;
    margin: 0 auto 24px;
  }
  .wizard-title { font-size: 26px; font-weight: 700; color: var(--text-1); margin: 0 0 12px; }
  .wizard-desc  { font-size: 15px; color: var(--text-2); line-height: 1.6; margin: 0 0 32px; }
  .wizard-btn   { width: 100%; padding: 14px; font-size: 16px; border-radius: var(--radius-md); }

  .wizard-step-title { font-size: 22px; font-weight: 700; color: var(--text-1); margin: 0 0 8px; }
  .wiz-optional { font-size: 13px; font-weight: 500; color: var(--text-3); }
  .wizard-step-desc  { font-size: 14px; color: var(--text-2); margin: 0 0 24px; line-height: 1.6; }

  /* Toggle row */
  .toggle-row {
    display: flex; align-items: center; justify-content: space-between;
    padding: 14px 16px; margin-bottom: 16px;
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-lg);
  }
  .toggle-label { font-size: 14px; font-weight: 600; color: var(--text-1); }
  .toggle-pill {
    width: 44px; height: 24px; border-radius: 12px;
    background: var(--surface-3); border: none; cursor: pointer;
    position: relative; transition: background var(--dur-fast);
  }
  .toggle-pill.active { background: var(--accent); }
  .toggle-thumb {
    position: absolute; top: 2px; left: 2px;
    width: 20px; height: 20px; border-radius: 50%;
    background: #fff; transition: transform var(--dur-fast);
  }
  .toggle-pill.active .toggle-thumb { transform: translateX(20px); }

  /* User management form */
  .um-form { display: flex; flex-direction: column; gap: 10px; margin-bottom: 16px; text-align: left; }
  .wiz-input {
    width: 100%; padding: 10px 14px;
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-md);
    color: var(--text-1); font-size: 14px; font-family: inherit;
    outline: none;
  }
  .wiz-input:focus { border-color: var(--accent); }
  .um-error { font-size: 12px; color: var(--danger); }

  /* Unit selection */
  /* Body-profile step (step 3) — stacked label/value rows. */
  .bp-grid    { display: flex; flex-direction: column; gap: 12px; margin-bottom: 8px; text-align: left; max-width: 360px; margin-left: auto; margin-right: auto; }
  .bp-row     { display: flex; align-items: center; gap: 12px; }
  .bp-label   { flex: 0 0 96px; font-size: 13px; font-weight: 600; color: var(--text-2); }
  .bp-input   { flex: 1; height: 42px; padding: 0 12px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--surface-2); color: var(--text-1); font-size: 14px; font-family: inherit; }
  .bp-input:focus { outline: none; border-color: var(--accent); }
  .bp-pair    { flex: 1; display: flex; align-items: center; gap: 6px; }
  .bp-narrow  { flex: 0 0 64px; }
  .bp-unit    { font-size: 13px; color: var(--text-3); min-width: 24px; }
  .bp-hint    { font-size: 12px; color: var(--text-3); line-height: 1.5; margin: 12px 0 16px; max-width: 360px; margin-left: auto; margin-right: auto; }

  /* Measurement-system cards — Metric / Imperial. One choice drives weight
     and height settings; the body-profile step's input branches on it. */
  .unit-cards { display: flex; gap: 12px; margin-bottom: 24px; }
  .unit-card {
    flex: 1; position: relative;
    display: flex; flex-direction: column; align-items: center; gap: 6px;
    padding: 22px 12px 18px;
    border-radius: var(--radius-lg);
    background: var(--surface-2); border: 2px solid var(--border);
    cursor: pointer; color: var(--text-2);
    transition: all var(--dur-fast);
    font-family: inherit;
  }
  .unit-card.selected { border-color: var(--accent); background: var(--accent-dim); color: var(--accent); }
  .unit-card-icon  { font-size: 40px; color: inherit; }
  .unit-card-label { font-size: 18px; font-weight: 700; }
  .unit-card-sub   { font-size: 12px; color: var(--text-3); }
  .unit-card.selected .unit-card-sub { color: var(--accent); opacity: 0.85; }
  .unit-card-check {
    position: absolute; top: 8px; right: 8px;
    font-size: 20px; color: var(--accent);
  }

  /* Goal selection */
  .goal-options { display: flex; gap: 8px; margin-bottom: 24px; flex-wrap: wrap; justify-content: center; }
  .goal-btn {
    display: flex; flex-direction: column; align-items: center; gap: 2px;
    padding: 14px 16px;
    border-radius: var(--radius-lg);
    background: var(--surface-2); border: 2px solid var(--border);
    cursor: pointer; color: var(--text-2);
    transition: all var(--dur-fast); min-width: 60px;
  }
  .goal-btn.active { border-color: var(--accent); background: var(--accent-dim); color: var(--accent); }
  .goal-num { font-size: 22px; font-weight: 700; }
  .goal-sub { font-size: 11px; }

  /* Theme selection */
  .theme-options { display: flex; gap: 10px; margin-bottom: 24px; justify-content: center; }
  .theme-btn {
    display: flex; flex-direction: column; align-items: center; gap: 6px;
    padding: 16px 20px;
    border-radius: var(--radius-lg);
    background: var(--surface-2); border: 2px solid var(--border);
    cursor: pointer; color: var(--text-2);
    transition: all var(--dur-fast); font-size: 13px;
  }
  .theme-btn.active { border-color: var(--accent); background: var(--accent-dim); color: var(--accent); }
  .theme-icon { font-size: 24px; }

  .wizard-nav { display: flex; gap: 10px; }
  .wizard-btn-sm { flex: 1; padding: 13px; border-radius: var(--radius-md); }

  /* Library picker */
  .lib-list { display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px; text-align: left; }
  .lib-row {
    display: flex; align-items: flex-start; gap: 12px;
    padding: 12px; cursor: pointer;
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    transition: all var(--dur-fast);
  }
  .lib-row:hover { background: var(--surface-3); }
  .lib-row.selected { border-color: var(--accent); background: var(--accent-dim); }
  .lib-check {
    width: 22px; height: 22px; border-radius: var(--radius-sm);
    border: 2px solid var(--border-strong);
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
    transition: all var(--dur-fast);
  }
  .lib-check.checked { background: var(--accent); border-color: var(--accent); color: #fff; }
  .lib-check .material-symbols-rounded { font-size: 16px; }
  .lib-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .lib-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .lib-name { font-size: 14px; font-weight: 700; color: var(--text-1); }
  .lib-license {
    font-size: 10px; font-weight: 700; padding: 2px 6px;
    border-radius: var(--radius-sm);
    background: var(--surface-1); border: 1px solid var(--border);
    color: var(--text-3); text-transform: uppercase; letter-spacing: 0.04em;
  }
  .lib-desc { font-size: 12px; color: var(--text-2); line-height: 1.4; }
  .lib-note { font-size: 11px; color: var(--text-3); font-style: italic; }
  .lib-progress {
    padding: 10px 12px; margin-bottom: 10px;
    background: var(--accent-dim); border: 1px solid var(--accent);
    border-radius: var(--radius-md);
    font-size: 12px; color: var(--accent); font-weight: 600;
  }

  .wizard-dots { display: flex; gap: 8px; justify-content: center; margin-top: 24px; }

  /* Skip-wizard top bar — sits above the card content from step 1 onwards.
     Mirrors NutriTrace's wizard-topbar pattern. */
  .wizard-topbar {
    display: flex; justify-content: flex-end;
    margin: -16px -16px 12px;
  }
  .wizard-skip {
    height: 36px; padding: 0 14px; font-size: 13px;
    color: var(--text-3);
  }
  .wizard-skip:hover { color: var(--text-1); }

  /* "I'll do this later" link on the welcome step — quieter than a button. */
  .skip-setup-link {
    background: none; border: none; cursor: pointer;
    margin-top: 12px;
    padding: 8px 12px;
    font-family: inherit; font-size: 13px;
    color: var(--text-3);
    text-decoration: underline;
  }
  .skip-setup-link:hover { color: var(--text-1); }

  /* Skip-confirmation modal */
  .skip-modal-backdrop {
    position: fixed; inset: 0; z-index: 300;
    background: rgba(0,0,0,0.55);
    display: flex; align-items: center; justify-content: center;
    padding: 16px;
  }
  .skip-modal {
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: var(--radius-xl);
    padding: 22px; max-width: 380px; width: 100%;
    box-shadow: var(--shadow-lg);
  }
  .skip-modal-title { font-size: 18px; font-weight: 700; color: var(--text-1); margin: 0 0 8px; }
  .skip-modal-desc  { font-size: 14px; color: var(--text-2); line-height: 1.5; margin: 0 0 16px; }
  .skip-modal-actions { display: flex; gap: 8px; justify-content: flex-end; }
  .dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: var(--border-strong);
    transition: background var(--dur-base), width var(--dur-base);
  }
  .dot.active { background: var(--accent); width: 24px; border-radius: 4px; }
</style>
