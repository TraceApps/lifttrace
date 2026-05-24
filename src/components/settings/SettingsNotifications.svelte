<script>
  import { slide } from 'svelte/transition';
  import { _ } from 'svelte-i18n';
  import Toggle from './Toggle.svelte';
  import ConnectionStatus from './ConnectionStatus.svelte';
  import {
    notifLocalEnabled, notifPushService,
    gotifyUrl, gotifyToken, ntfyUrl, ntfyTopic, ntfyToken, appriseUrl, appriseTag,
    notifWorkoutReminder, notifWorkoutTime, notifRestDay,
    notifStreakAlert, notifStreakTime,
    notifWorkoutComplete, notifPRCelebrations,
    notifMemberCompletes, notifMemberMissed, notifMemberReply,
    notifCoachFeedback,
    notifWeeklySummary, weeklySummaryDay, weeklySummaryTime,
  } from '../../stores/settings.js';
  import { currentUser } from '../../stores/auth.js';
  import { showSuccess, showError } from '../../stores/toast.js';
  $: isCoach = $currentUser?.role === 'trainer' || $currentUser?.role === 'admin';

  export let expanded = false;
  export let visible = true;
  export let onToggle = () => {};

  let pushTesting = false;
  let pushTestResult = null;
  let pushShowToken = false;
  $: anyNotifEnabled = $notifLocalEnabled || $notifPushService !== 'none';

  // Adjust copy + permission UX to match the platform.
  import { isNative } from '../../lib/platform.js';
  let _permissionState = 'default';
  async function _refreshPermissionState() {
    try {
      const { hasPermission } = await import('../../lib/notifications.js');
      _permissionState = (await hasPermission()) ? 'granted' : 'default';
    } catch { _permissionState = 'default'; }
  }
  async function _requestPermission() {
    try {
      const { requestPermission } = await import('../../lib/notifications.js');
      await requestPermission();
      await _refreshPermissionState();
    } catch {}
  }
  $: if ($notifLocalEnabled) _refreshPermissionState();

  async function testPush() {
    pushTesting = true; pushTestResult = null;
    try {
      const res = await fetch('/api/settings/push-test', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service: $notifPushService }),
      });
      if (!res.ok) {
        const data = await res.json();
        showError(data.error || 'Test failed');
        pushTestResult = 'fail';
      } else {
        pushTestResult = 'ok';
        showSuccess('Test sent, check your device');
      }
    } catch { pushTestResult = 'fail'; }
    pushTesting = false;
  }

  // Push services follow the same pattern as SettingsEmail / NT's SMTP:
  // "Configured" as soon as the required fields are filled (creds entered,
  // never verified), "Last Test Sent" after a successful test. A failed
  // test takes priority. Single banner state since only one provider is
  // active at a time.
  $: _pushConfigured = $notifPushService === 'gotify'  ? !!($gotifyUrl && $gotifyToken)
                     : $notifPushService === 'ntfy'    ? !!($ntfyUrl && $ntfyTopic)
                     : $notifPushService === 'apprise' ? !!$appriseUrl
                     : false;
  $: pushBannerStatus = pushTesting
    ? 'testing'
    : pushTestResult === 'fail'
      ? 'fail'
      : (_pushConfigured ? 'ok' : '');
  $: pushBannerDisabled = pushTesting || !_pushConfigured;
  // Clear stale test result when the user switches providers so the banner
  // doesn't carry over a "Last Test Sent" pill from a different service.
  let _lastPushProvider = $notifPushService;
  $: if ($notifPushService !== _lastPushProvider) {
    _lastPushProvider = $notifPushService;
    pushTestResult = null;
  }
  // Provider chip rendered in the banner so the user always sees which
  // service the "Configured" / "Last Test Sent" state refers to.
  $: pushProviderLabel = $notifPushService === 'gotify'  ? 'Gotify'
                       : $notifPushService === 'ntfy'    ? 'ntfy'
                       : $notifPushService === 'apprise' ? 'Apprise'
                       : '';
</script>

{#if visible}
  <button class="section-toggle" on:click={onToggle}>
    <span class="si"><span class="material-symbols-rounded">notifications</span></span>
    <span class="section-name">{$_('settings.notifications.section')}</span>
    <span class="material-symbols-rounded chevron" class:rotated={expanded}>expand_more</span>
  </button>
  {#if expanded}
    <div class="section-body" transition:slide={{ duration: 180 }}>
      <p class="sub-label">Delivery</p>
      <div class="card">
        {#if $notifPushService !== 'none'}
          <ConnectionStatus
            status={pushBannerStatus}
            okLabel="Configured"
            connectedAs={pushProviderLabel}
            error={pushTestResult === 'fail' ? `${pushProviderLabel} test failed — check the URL and credentials below` : ''}
            onRetest={testPush}
            retestDisabled={pushBannerDisabled}
            retestLabel="Send Test"
          />
        {/if}
        <div class="setting-row">
          <div class="setting-label-group">
            <span class="setting-label">Device Notifications</span>
            <span class="setting-hint">{isNative ? 'System notifications shown by Android in the status bar and on the lock screen' : 'Browser notification alerts'}</span>
          </div>
          <Toggle bind:checked={$notifLocalEnabled} />
        </div>
        {#if $notifLocalEnabled && _permissionState !== 'granted'}
          <div class="setting-row">
            <div class="setting-label-group">
              <span class="setting-hint" style="color:var(--warn,#FFB347)">
                {isNative ? 'Android needs permission to show notifications.' : 'The browser needs permission to show notifications.'}
              </span>
            </div>
            <button class="btn btn-secondary" style="height:32px;font-size:12px" on:click={_requestPermission}>
              Grant
            </button>
          </div>
        {/if}
        <div class="setting-row">
          <div class="setting-label-group">
            <span class="setting-label">Push Service</span>
            <span class="setting-hint">External push delivery (Gotify, ntfy, or Apprise)</span>
          </div>
          <select class="form-select-sm" bind:value={$notifPushService}>
            <option value="none">None</option>
            <option value="apprise">Apprise</option>
            <option value="gotify">Gotify</option>
            <option value="ntfy">ntfy</option>
          </select>
        </div>
      </div>

      {#if $notifPushService === 'gotify'}
        <div class="card" style="padding:16px;display:flex;flex-direction:column;gap:12px">
          <div class="form-group">
            <label class="form-label">Gotify Server URL</label>
            <input class="form-input" type="text" bind:value={$gotifyUrl} placeholder="https://gotify.example.com" />
          </div>
          <div class="form-group">
            <label class="form-label">App Token</label>
            <div style="display:flex;gap:8px;align-items:center">
              {#if pushShowToken}
                <input class="form-input" style="flex:1" type="text" bind:value={$gotifyToken} placeholder="Gotify app token" />
              {:else}
                <input class="form-input" style="flex:1" type="password" bind:value={$gotifyToken} placeholder="Gotify app token" />
              {/if}
              <button class="btn-icon-toggle" on:click={() => pushShowToken = !pushShowToken} title={pushShowToken ? 'Hide' : 'Show'}>
                <span class="material-symbols-rounded">{pushShowToken ? 'visibility_off' : 'visibility'}</span>
              </button>
            </div>
          </div>
        </div>
      {:else if $notifPushService === 'ntfy'}
        <div class="card" style="padding:16px;display:flex;flex-direction:column;gap:12px">
          <div class="form-group">
            <label class="form-label">ntfy Server URL</label>
            <input class="form-input" type="text" bind:value={$ntfyUrl} placeholder="https://ntfy.sh" />
          </div>
          <div class="form-group">
            <label class="form-label">Topic</label>
            <input class="form-input" type="text" bind:value={$ntfyTopic} placeholder="lifttrace" />
          </div>
          <div class="form-group">
            <label class="form-label">Access Token (optional)</label>
            <div style="display:flex;gap:8px;align-items:center">
              {#if pushShowToken}
                <input class="form-input" style="flex:1" type="text" bind:value={$ntfyToken} placeholder="Bearer token" />
              {:else}
                <input class="form-input" style="flex:1" type="password" bind:value={$ntfyToken} placeholder="Bearer token" />
              {/if}
              <button class="btn-icon-toggle" on:click={() => pushShowToken = !pushShowToken} title={pushShowToken ? 'Hide' : 'Show'}>
                <span class="material-symbols-rounded">{pushShowToken ? 'visibility_off' : 'visibility'}</span>
              </button>
            </div>
          </div>
        </div>
      {:else if $notifPushService === 'apprise'}
        <div class="card" style="padding:16px;display:flex;flex-direction:column;gap:12px">
          <div class="form-group">
            <label class="form-label">Apprise Server URL</label>
            <input class="form-input" type="text" bind:value={$appriseUrl} placeholder="http://apprise:8000" />
          </div>
          <div class="form-group">
            <label class="form-label">Tag (optional)</label>
            <input class="form-input" type="text" bind:value={$appriseTag} placeholder="lifttrace" />
          </div>
        </div>
      {/if}

      {#if anyNotifEnabled}
        <p class="sub-label">Scheduled Reminders</p>
        <div class="card">
          <div class="setting-row">
            <div class="setting-label-group">
              <span class="setting-label">Workout Reminder</span>
              <span class="setting-hint">Daily reminder to train</span>
            </div>
            <Toggle bind:checked={$notifWorkoutReminder} />
          </div>
          {#if $notifWorkoutReminder}
            <div class="setting-row">
              <span class="setting-label">Time</span>
              <input class="form-input-sm" type="time" bind:value={$notifWorkoutTime} style="width:120px" />
            </div>
          {/if}
          <div class="setting-row">
            <div class="setting-label-group">
              <span class="setting-label">Rest Day Reminder</span>
              <span class="setting-hint">Reminds you to recover after training days</span>
            </div>
            <Toggle bind:checked={$notifRestDay} />
          </div>
          <div class="setting-row">
            <div class="setting-label-group">
              <span class="setting-label">Streak Alert</span>
              <span class="setting-hint">Warns when your streak is at risk</span>
            </div>
            <Toggle bind:checked={$notifStreakAlert} />
          </div>
          {#if $notifStreakAlert}
            <div class="setting-row">
              <span class="setting-label">Alert Time</span>
              <input class="form-input-sm" type="time" bind:value={$notifStreakTime} style="width:120px" />
            </div>
          {/if}
        </div>

        <p class="sub-label">Alerts & Celebrations</p>
        <div class="card">
          <div class="setting-row">
            <div class="setting-label-group">
              <span class="setting-label">Workout Complete</span>
              <span class="setting-hint">Celebrate when all sets are done</span>
            </div>
            <Toggle bind:checked={$notifWorkoutComplete} />
          </div>
          <div class="setting-row">
            <div class="setting-label-group">
              <span class="setting-label">Personal Records</span>
              <span class="setting-hint">Celebrate when you hit a new PR</span>
            </div>
            <Toggle bind:checked={$notifPRCelebrations} />
          </div>
          <div class="setting-row">
            <div class="setting-label-group">
              <span class="setting-label">Coach Feedback</span>
              <span class="setting-hint">Ping when your coach leaves a note on a workout</span>
            </div>
            <Toggle bind:checked={$notifCoachFeedback} />
          </div>
        </div>

        {#if isCoach}
          <p class="sub-label">Coaching</p>
          <div class="card">
            <div class="setting-row">
              <div class="setting-label-group">
                <span class="setting-label">Member completes prescribed workout</span>
                <span class="setting-hint">Push when a member finishes a workout you prescribed for that day</span>
              </div>
              <Toggle bind:checked={$notifMemberCompletes} />
            </div>
            <div class="setting-row">
              <div class="setting-label-group">
                <span class="setting-label">Member missed a prescription</span>
                <span class="setting-hint">Push the morning after a dated prescription's day passes without a completed workout</span>
              </div>
              <Toggle bind:checked={$notifMemberMissed} />
            </div>
            <div class="setting-row">
              <div class="setting-label-group">
                <span class="setting-label">Member replied to feedback</span>
                <span class="setting-hint">Push when a coachee replies to one of your notes</span>
              </div>
              <Toggle bind:checked={$notifMemberReply} />
            </div>
          </div>
        {/if}

        <p class="sub-label">Summaries</p>
        <div class="card">
          <div class="setting-row">
            <div class="setting-label-group">
              <span class="setting-label">Weekly Summary</span>
              <span class="setting-hint">Push + email digest of your training week</span>
            </div>
            <Toggle bind:checked={$notifWeeklySummary} />
          </div>
          {#if $notifWeeklySummary}
            <div class="setting-row">
              <span class="setting-label">Delivery Day</span>
              <select class="form-select-sm" bind:value={$weeklySummaryDay}>
                {#each ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'] as d, i}
                  <option value={i}>{d}</option>
                {/each}
              </select>
            </div>
            <div class="setting-row">
              <span class="setting-label">Delivery Time</span>
              <input class="form-input-sm" type="time" bind:value={$weeklySummaryTime} style="width:120px" />
            </div>
          {/if}
        </div>
      {/if}
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
  .btn-icon-toggle {
    background: none; border: none; cursor: pointer; color: var(--text-3);
    padding: 6px; display: flex; border-radius: var(--radius-sm);
  }
  .btn-icon-toggle:hover { color: var(--text-1); background: var(--surface-2); }
</style>
