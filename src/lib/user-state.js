/**
 * user-state.js: what the app keeps in memory for the account signed in.
 *
 * Module stores outlive a sign-out (and the Android app doesn't reload on
 * one), so the next account would see, and could change or save, the last
 * one's:
 *   - every setting store (stores/settings.js): notification tokens, the
 *     radio password, favorites, rest kept per exercise and the rest are
 *     kept per account in storage, but each store holds the value it read
 *     last, and a change still waiting to be sent would go up under the
 *     next account;
 *   - the workout on show (stores/workout.js): the day, its sessions, the
 *     program being followed, a coach's prescription, and a save still
 *     waiting to go;
 *   - the rest, hold and workout timers (stores/restTimer.js,
 *     holdTimer.js, workoutTimer.js), which also write back to settings;
 *   - what's playing (stores/player.js: the account's music server and
 *     radio, with its password);
 *   - progress photos held in memory (lib/photo-blobs.js) and the exercise
 *     list Smart Log keeps (lib/smartLogWorkout.js).
 * Cleared when the copy changes hands (local-account.js: another account,
 * Connect, Disconnect) and on sign-out (stores/auth.js), before the next
 * account's data is shown. Pages keep the rest in their own state, which
 * goes with them when the sign-in screen (or the account check) replaces
 * the app. Settings for this device rather than an account (player volume,
 * the server address) stay. Reminders scheduled on this device are set
 * again from the new account's settings. Same design as NutriTrace's.
 */
export async function resetUserState() {
  await Promise.allSettled([
    import('../stores/settings.js').then(m => m.reloadSettingStores({ force: true })),
    import('../stores/workout.js').then(m => m.resetWorkoutState()),
    import('../stores/restTimer.js').then(m => m.stopRest(false)),
    import('../stores/holdTimer.js').then(m => m.cancelHold()),
    import('../stores/workoutTimer.js').then(m => m.resetTimer()),
    import('../stores/player.js').then(m => m.clearQueue()),
    import('./photo-blobs.js').then(m => m.clearPhotoBlobs()),
    import('./smartLogWorkout.js').then(m => m.forgetLibraryCache()),
  ]);
  // Reminders on this device follow the account's settings (now the next
  // one's, or none when signed out).
  try { await (await import('./notifications.js')).scheduleNativeReminders(); } catch { /* not native */ }
}
