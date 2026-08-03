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
        showError(data.error || $_('settings_notifications.toast.test_failed'));
        pushTestResult = 'fail';
      } else {
        pushTestResult = 'ok';
        showSuccess($_('settings_notifications.toast.test_sent'));
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
      <p class="sub-label">{$_('settings_notifications.sections.delivery')}</p>
      <div class="card">
        {#if $notifPushService !== 'none'}
          <ConnectionStatus
            status={pushBannerStatus}
            okLabel={$_('settings_notifications.push.configured')}
            connectedAs={pushProviderLabel}
            error={pushTestResult === 'fail' ? $_('settings_notifications.push.test_failed_hint', { values: { provider: pushProviderLabel } }) : ''}
            onRetest={testPush}
            retestDisabled={pushBannerDisabled}
            retestLabel={$_('settings_notifications.push.send_test')}
          />
        {/if}
        <div class="setting-row">
          <div class="setting-label-group">
            <span class="setting-label">{$_('settings_notifications.push.device')}</span>
            <span class="setting-hint">{isNative ? $_('settings_notifications.push.device_desc_native') : $_('settings_notifications.push.device_desc_web')}</span>
          </div>
          <Toggle bind:checked={$notifLocalEnabled} />
        </div>
        {#if $notifLocalEnabled && _permissionState !== 'granted'}
          <div class="setting-row">
            <div class="setting-label-group">
              <span class="setting-hint" style="color:var(--warn,#FFB347)">
                {isNative ? $_('settings_notifications.push.perm_hint_native') : $_('settings_notifications.push.perm_hint_web')}
              </span>
            </div>
            <button class="btn btn-secondary" style="height:32px;font-size:12px" on:click={_requestPermission}>
              {$_('settings_notifications.push.grant')}
            </button>
          </div>
        {/if}
        <div class="setting-row">
          <div class="setting-label-group">
            <span class="setting-label">{$_('settings_notifications.push.push_service')}</span>
            <span class="setting-hint">{$_('settings_notifications.push.push_service_desc')}</span>
          </div>
          <select class="form-select-sm" bind:value={$notifPushService}>
            <option value="none">{$_('settings_notifications.push.option_none')}</option>
            <option value="apprise">{$_('settings_notifications.push.option_apprise')}</option>
            <option value="gotify">{$_('settings_notifications.push.option_gotify')}</option>
            <option value="ntfy">{$_('settings_notifications.push.option_ntfy')}</option>
          </select>
        </div>
      </div>

      {#if $notifPushService === 'gotify'}
        <div class="card" style="padding:16px;display:flex;flex-direction:column;gap:12px">
          <div class="form-group">
            <label class="form-label">{$_('settings_notifications.push.gotify_url')}</label>
            <input class="form-input" type="text" bind:value={$gotifyUrl} placeholder={$_('settings_notifications.push.gotify_url_ph')} />
          </div>
          <div class="form-group">
            <label class="form-label">{$_('settings_notifications.push.gotify_token')}</label>
            <div style="display:flex;gap:8px;align-items:center">
              {#if pushShowToken}
                <input class="form-input" style="flex:1" type="text" bind:value={$gotifyToken} placeholder={$_('settings_notifications.push.gotify_token_ph')} />
              {:else}
                <input class="form-input" style="flex:1" type="password" bind:value={$gotifyToken} placeholder={$_('settings_notifications.push.gotify_token_ph')} />
              {/if}
              <button class="btn-icon-toggle" on:click={() => pushShowToken = !pushShowToken} title={pushShowToken ? $_('settings_notifications.push.hide') : $_('settings_notifications.push.show')}>
                <span class="material-symbols-rounded">{pushShowToken ? 'visibility_off' : 'visibility'}</span>
              </button>
            </div>
          </div>
        </div>
      {:else if $notifPushService === 'ntfy'}
        <div class="card" style="padding:16px;display:flex;flex-direction:column;gap:12px">
          <div class="form-group">
            <label class="form-label">{$_('settings_notifications.push.ntfy_url')}</label>
            <input class="form-input" type="text" bind:value={$ntfyUrl} placeholder={$_('settings_notifications.push.ntfy_url_ph')} />
          </div>
          <div class="form-group">
            <label class="form-label">{$_('settings_notifications.push.ntfy_topic')}</label>
            <input class="form-input" type="text" bind:value={$ntfyTopic} placeholder={$_('settings_notifications.push.ntfy_topic_ph')} />
          </div>
          <div class="form-group">
            <label class="form-label">{$_('settings_notifications.push.ntfy_token')}</label>
            <div style="display:flex;gap:8px;align-items:center">
              {#if pushShowToken}
                <input class="form-input" style="flex:1" type="text" bind:value={$ntfyToken} placeholder={$_('settings_notifications.push.ntfy_token_ph')} />
              {:else}
                <input class="form-input" style="flex:1" type="password" bind:value={$ntfyToken} placeholder={$_('settings_notifications.push.ntfy_token_ph')} />
              {/if}
              <button class="btn-icon-toggle" on:click={() => pushShowToken = !pushShowToken} title={pushShowToken ? $_('settings_notifications.push.hide') : $_('settings_notifications.push.show')}>
                <span class="material-symbols-rounded">{pushShowToken ? 'visibility_off' : 'visibility'}</span>
              </button>
            </div>
          </div>
        </div>
      {:else if $notifPushService === 'apprise'}
        <div class="card" style="padding:16px;display:flex;flex-direction:column;gap:12px">
          <div class="form-group">
            <label class="form-label">{$_('settings_notifications.push.apprise_url')}</label>
            <input class="form-input" type="text" bind:value={$appriseUrl} placeholder={$_('settings_notifications.push.apprise_url_ph')} />
          </div>
          <div class="form-group">
            <label class="form-label">{$_('settings_notifications.push.apprise_tag')}</label>
            <input class="form-input" type="text" bind:value={$appriseTag} placeholder={$_('settings_notifications.push.apprise_tag_ph')} />
          </div>
        </div>
      {/if}

      {#if anyNotifEnabled}
        <p class="sub-label">{$_('settings_notifications.sections.scheduled_reminders')}</p>
        <div class="card">
          <div class="setting-row">
            <div class="setting-label-group">
              <span class="setting-label">{$_('settings_notifications.reminders.workout')}</span>
              <span class="setting-hint">{$_('settings_notifications.reminders.workout_desc')}</span>
            </div>
            <Toggle bind:checked={$notifWorkoutReminder} />
          </div>
          {#if $notifWorkoutReminder}
            <div class="setting-row">
              <span class="setting-label">{$_('settings_notifications.reminders.time')}</span>
              <input class="form-input-sm" type="time" bind:value={$notifWorkoutTime} style="width:120px" />
            </div>
          {/if}
          <div class="setting-row">
            <div class="setting-label-group">
              <span class="setting-label">{$_('settings_notifications.reminders.rest_day')}</span>
              <span class="setting-hint">{$_('settings_notifications.reminders.rest_day_desc')}</span>
            </div>
            <Toggle bind:checked={$notifRestDay} />
          </div>
          <div class="setting-row">
            <div class="setting-label-group">
              <span class="setting-label">{$_('settings_notifications.reminders.streak')}</span>
              <span class="setting-hint">{$_('settings_notifications.reminders.streak_desc')}</span>
            </div>
            <Toggle bind:checked={$notifStreakAlert} />
          </div>
          {#if $notifStreakAlert}
            <div class="setting-row">
              <span class="setting-label">{$_('settings_notifications.reminders.alert_time')}</span>
              <input class="form-input-sm" type="time" bind:value={$notifStreakTime} style="width:120px" />
            </div>
          {/if}
        </div>

        <p class="sub-label">{$_('settings_notifications.sections.alerts')}</p>
        <div class="card">
          <div class="setting-row">
            <div class="setting-label-group">
              <span class="setting-label">{$_('settings_notifications.alerts.complete')}</span>
              <span class="setting-hint">{$_('settings_notifications.alerts.complete_desc')}</span>
            </div>
            <Toggle bind:checked={$notifWorkoutComplete} />
          </div>
          <div class="setting-row">
            <div class="setting-label-group">
              <span class="setting-label">{$_('settings_notifications.alerts.prs')}</span>
              <span class="setting-hint">{$_('settings_notifications.alerts.prs_desc')}</span>
            </div>
            <Toggle bind:checked={$notifPRCelebrations} />
          </div>
          <div class="setting-row">
            <div class="setting-label-group">
              <span class="setting-label">{$_('settings_notifications.alerts.coach_feedback')}</span>
              <span class="setting-hint">{$_('settings_notifications.alerts.coach_feedback_desc')}</span>
            </div>
            <Toggle bind:checked={$notifCoachFeedback} />
          </div>
        </div>

        {#if isCoach}
          <p class="sub-label">{$_('settings_notifications.sections.coaching')}</p>
          <div class="card">
            <div class="setting-row">
              <div class="setting-label-group">
                <span class="setting-label">{$_('settings_notifications.coach.member_completes')}</span>
                <span class="setting-hint">{$_('settings_notifications.coach.member_completes_desc')}</span>
              </div>
              <Toggle bind:checked={$notifMemberCompletes} />
            </div>
            <div class="setting-row">
              <div class="setting-label-group">
                <span class="setting-label">{$_('settings_notifications.coach.member_missed')}</span>
                <span class="setting-hint">{$_('settings_notifications.coach.member_missed_desc')}</span>
              </div>
              <Toggle bind:checked={$notifMemberMissed} />
            </div>
            <div class="setting-row">
              <div class="setting-label-group">
                <span class="setting-label">{$_('settings_notifications.coach.member_reply')}</span>
                <span class="setting-hint">{$_('settings_notifications.coach.member_reply_desc')}</span>
              </div>
              <Toggle bind:checked={$notifMemberReply} />
            </div>
          </div>
        {/if}

        <p class="sub-label">{$_('settings_notifications.sections.summaries')}</p>
        <div class="card">
          <div class="setting-row">
            <div class="setting-label-group">
              <span class="setting-label">{$_('settings_notifications.summaries.weekly')}</span>
              <span class="setting-hint">{$_('settings_notifications.summaries.weekly_desc')}</span>
            </div>
            <Toggle bind:checked={$notifWeeklySummary} />
          </div>
          {#if $notifWeeklySummary}
            <div class="setting-row">
              <span class="setting-label">{$_('settings_notifications.summaries.delivery_day')}</span>
              <select class="form-select-sm" bind:value={$weeklySummaryDay}>
                {#each [$_('settings_notifications.summaries.day_sun'), $_('settings_notifications.summaries.day_mon'), $_('settings_notifications.summaries.day_tue'), $_('settings_notifications.summaries.day_wed'), $_('settings_notifications.summaries.day_thu'), $_('settings_notifications.summaries.day_fri'), $_('settings_notifications.summaries.day_sat')] as d, i}
                  <option value={i}>{d}</option>
                {/each}
              </select>
            </div>
            <div class="setting-row">
              <span class="setting-label">{$_('settings_notifications.summaries.delivery_time')}</span>
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
