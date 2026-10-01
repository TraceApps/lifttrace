const settingWrites = new Map();

/** Persist a setting now while preserving write order for repeated changes. */
export function persistSettingImmediately(key, value, { saveSetting, cancelScheduledSave }) {
  if (typeof saveSetting !== 'function') throw new TypeError('saveSetting is required');
  cancelScheduledSave?.(key);

  const previous = settingWrites.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(() => {
    // A queued generic debounce may have been scheduled while this write was
    // waiting behind an earlier explicit toggle.
    cancelScheduledSave?.(key);
    return saveSetting(key, value);
  });
  settingWrites.set(key, current);

  return current.finally(() => {
    if (settingWrites.get(key) === current) settingWrites.delete(key);
  });
}

/**
 * Apply one tested federation connection as a bounded sequence of one-key
 * PUTs. Federation is disabled before connection fields change and enabled
 * only after the canonical identity and verification state are durable.
 */
export async function persistFederationConnectionTransition({
  previous,
  next,
  saveSetting,
  cancelScheduledSave,
}) {
  if (typeof saveSetting !== 'function') throw new TypeError('saveSetting is required');

  const keys = [
    'ntFederationEnabled',
    'ntInstanceUrl',
    'ntInstanceToken',
    'ntConnectionIdentity',
    'ntConnectionVerified',
  ];
  const bodySyncChanged = previous.ntBodySyncEnabled !== next.ntBodySyncEnabled;
  if (bodySyncChanged) keys.push('ntBodySyncEnabled');
  for (const key of keys) cancelScheduledSave?.(key);

  const write = (key, value) => persistSettingImmediately(key, value, {
    saveSetting,
    cancelScheduledSave,
  });

  let disabledBarrierCompleted = false;
  try {
    await write('ntFederationEnabled', false);
    disabledBarrierCompleted = true;
    await write('ntInstanceUrl', next.ntInstanceUrl);
    await write('ntInstanceToken', next.ntInstanceToken);
    await write('ntConnectionIdentity', next.ntConnectionIdentity);
    await write('ntConnectionVerified', next.ntConnectionVerified);
    if (bodySyncChanged) await write('ntBodySyncEnabled', next.ntBodySyncEnabled);
    await write('ntFederationEnabled', next.ntFederationEnabled);
  } catch (cause) {
    let rollbackError = null;
    try {
      // Restore the old connection behind the same OFF barrier. The old
      // connection is re-enabled only after all of its values are restored.
      await write('ntFederationEnabled', false);
      await write('ntInstanceUrl', previous.ntInstanceUrl);
      await write('ntInstanceToken', previous.ntInstanceToken);
      await write('ntConnectionIdentity', previous.ntConnectionIdentity);
      await write('ntConnectionVerified', previous.ntConnectionVerified);
      if (bodySyncChanged) await write('ntBodySyncEnabled', previous.ntBodySyncEnabled);
      if (previous.ntFederationEnabled) await write('ntFederationEnabled', true);
    } catch (error) {
      rollbackError = error;
      // If the transition had already confirmed OFF, keep the server disabled
      // when restoration stops partway through.
      if (disabledBarrierCompleted) {
        try { await write('ntFederationEnabled', false); } catch { /* surfaced below */ }
      }
    }

    const error = new Error('Unable to save NutriTrace federation settings.', { cause });
    if (rollbackError) error.rollbackError = rollbackError;
    throw error;
  }
}
