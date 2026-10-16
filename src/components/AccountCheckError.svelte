<script>
  // Shown when the app couldn't tell whose data this phone holds
  // (lib/local-account.js): none of it is shown, and the person can try
  // again or sign out. Never a blank screen, never another account's data.
  import { createEventDispatcher } from 'svelte';
  import { _ } from 'svelte-i18n';
  const dispatch = createEventDispatcher();
</script>

<div class="account-check-error" role="alert">
  <span class="material-symbols-rounded" aria-hidden="true">error</span>
  <h2>{$_('sync.account_check_failed_title')}</h2>
  <p>{$_('sync.account_check_failed')}</p>
  <div class="account-check-actions">
    <button class="btn btn-primary" on:click={() => dispatch('retry')}>{$_('sync.retry')}</button>
    <button class="btn btn-ghost" on:click={() => dispatch('signout')}>{$_('common.sign_out')}</button>
  </div>
</div>

<style>
  .account-check-error {
    min-height: 100vh;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 12px; padding: calc(var(--safe-top, 0px) + 24px) 24px 24px; text-align: center;
  }
  .account-check-error .material-symbols-rounded { font-size: 48px; color: var(--danger); }
  .account-check-error h2 { margin: 0; font-size: 1.25rem; }
  .account-check-error p { margin: 0; max-width: 360px; color: var(--text-2); }
  .account-check-actions { display: flex; gap: 12px; margin-top: 8px; }
</style>
