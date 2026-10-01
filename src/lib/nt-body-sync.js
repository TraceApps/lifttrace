/**
 * NutriTrace body-measurement sync.
 *
 * The pure helpers keep source selection and field mapping independent from
 * the Settings screen. The orchestration deliberately writes partial body
 * stats through the existing API so manual circumference measurements stay
 * untouched.
 */
import { LtApi } from './api.js';

const LB_PER_KG = 2.2046226218;
const SYNC_WINDOW_DAYS = 90;
export const BODY_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;

let inFlight = null;

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function hasSupportedMetric(measurement) {
  const metrics = measurement?.metrics;
  return finiteNumber(metrics?.weight_kg) != null || finiteNumber(metrics?.body_fat_pct) != null;
}

export function collectRelevantSources(measurements) {
  if (!Array.isArray(measurements)) return [];
  return [...new Set(
    measurements
      .filter(hasSupportedMetric)
      .map(m => m?.source)
      .filter(source => typeof source === 'string' && source.length > 0)
  )];
}

export function resolveBodySource(measurements, selectedSource = '') {
  const sources = collectRelevantSources(measurements);
  if (selectedSource) {
    return {
      status: sources.includes(selectedSource) ? 'selected' : 'selected-empty',
      source: selectedSource,
      sources,
    };
  }
  if (sources.length === 0) return { status: 'no-data', source: null, sources };
  if (sources.length === 1) return { status: 'auto-selected', source: sources[0], sources };
  return { status: 'source-selection-required', source: null, sources };
}

export function mapNtObservationToLt(measurement, unit = 'kg') {
  const stats = {};
  const weightKg = finiteNumber(measurement?.metrics?.weight_kg);
  const bodyFat = finiteNumber(measurement?.metrics?.body_fat_pct);
  if (weightKg != null) {
    stats.weight = unit === 'kg'
      ? weightKg
      : Math.round(weightKg * LB_PER_KG * 100) / 100;
  }
  if (bodyFat != null) stats.bodyFat = bodyFat;
  return { stats, weightKg };
}

export function changedMappedStats(existingStats, incomingStats) {
  const existing = existingStats && typeof existingStats === 'object' ? existingStats : {};
  return Object.fromEntries(
    Object.entries(incomingStats || {}).filter(([key, value]) => {
      // `body_fat` is a legacy spelling. Keep one final write for rows that
      // still carry it so the server merge can normalize the row to bodyFat;
      // once normalized, the same sync is a no-op again.
      if (key === 'bodyFat' && Object.prototype.hasOwnProperty.call(existing, 'body_fat')) {
        return value !== undefined;
      }
      return existing[key] !== value;
    })
  );
}

export function newestWeightMeasurement(measurements) {
  return (Array.isArray(measurements) ? measurements : [])
    .filter(m => hasSupportedMetric(m) && finiteNumber(m?.metrics?.weight_kg) != null)
    .filter(m => typeof m.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(m.date))
    .sort((a, b) => a.date.localeCompare(b.date))
    .at(-1) || null;
}

function localDate(date = new Date()) {
  return date.toLocaleDateString('sv-SE');
}

function dateDaysAgo(days, now = new Date()) {
  const date = new Date(now);
  date.setDate(date.getDate() - days);
  return localDate(date);
}

function validResponse(measurements) {
  if (!Array.isArray(measurements)) throw new Error('NutriTrace returned malformed body measurements');
  for (const measurement of measurements) {
    if (!measurement || typeof measurement !== 'object' ||
        typeof measurement.date !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(measurement.date) ||
        typeof measurement.source !== 'string' ||
        !measurement.metrics || typeof measurement.metrics !== 'object' || Array.isArray(measurement.metrics)) {
      throw new Error('NutriTrace returned malformed body measurements');
    }
  }
}

function settingValue(store) {
  if (store && typeof store.get === 'function') return store.get();
  return undefined;
}

function stableConnectionIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const instanceUrl = typeof value.instanceUrl === 'string' ? value.instanceUrl : '';
  const userId = value.userId == null ? '' : String(value.userId);
  if (!instanceUrl || !userId) return null;
  return { instanceUrl, userId };
}

function sameConnectionIdentity(left, right) {
  const a = stableConnectionIdentity(left);
  const b = stableConnectionIdentity(right);
  return !!a && !!b && a.instanceUrl === b.instanceUrl && a.userId === b.userId;
}

async function defaultSettings() {
  return import('../stores/settings.js');
}

/**
 * Sync the selected NutriTrace source into LiftTrace body stats.
 * `manual` bypasses the six-hour foreground throttle but remains opt-in for
 * automatic runs. Errors are returned rather than thrown for silent callers.
 */
async function _syncNtBodyMeasurements({ manual = false, api = LtApi, settings, now = Date.now() } = {}) {
  try {
    const s = settings || await defaultSettings();
    if (!settingValue(s.ntFederationEnabled) || (!manual && !settingValue(s.ntBodySyncEnabled))) {
      return { status: 'disabled' };
    }

    const connectionIdentity = stableConnectionIdentity(settingValue(s.ntConnectionIdentity));
    if (!connectionIdentity) {
      return { status: 'connection-verification-required' };
    }
    const syncedConnectionIdentity = stableConnectionIdentity(settingValue(s.ntBodySyncedConnectionIdentity));
    const syncedSource = String(settingValue(s.ntBodySyncedSource) || '');
    if (syncedConnectionIdentity && !sameConnectionIdentity(connectionIdentity, syncedConnectionIdentity)) {
      return { status: 'connection-change-blocked' };
    }
    // A pre-identity provenance marker cannot safely be attributed to the
    // currently verified connection. Do not retrofit an identity after the
    // fact and risk mixing old and new body history.
    if (!syncedConnectionIdentity && syncedSource) {
      return { status: 'connection-change-blocked', syncedSource };
    }

    const lastSyncAt = Number(settingValue(s.ntBodyLastSyncAt) || 0);
    if (!manual && lastSyncAt > 0 && now - lastSyncAt < BODY_SYNC_INTERVAL_MS) {
      return { status: 'throttled', lastSyncAt };
    }

    const end = localDate(new Date(now));
    const start = dateDaysAgo(SYNC_WINDOW_DAYS, new Date(now));
    const selectedSource = String(settingValue(s.ntBodySource) || '');
    const response = await api.getNtBodyMeasurements(start, end, selectedSource || undefined);
    validResponse(response?.measurements);

    const decision = resolveBodySource(response.measurements, selectedSource);
    // An explicit attempt to move away from the source that already owns
    // imported fields is unsafe even when the new source has no observations
    // in the current window. Check this before selected-empty/no-data paths.
    if (syncedSource && selectedSource && syncedSource !== selectedSource) {
      return {
        status: 'source-change-blocked',
        source: selectedSource,
        syncedSource,
        sources: decision.sources,
      };
    }
    if (decision.status === 'source-selection-required') {
      return { status: decision.status, sources: decision.sources };
    }
    if (decision.status === 'no-data' || decision.status === 'selected-empty') {
      if (s.ntBodyLastSyncAt?.set) s.ntBodyLastSyncAt.set(now);
      return { status: decision.status, source: decision.source, sources: decision.sources, writes: 0 };
    }

    const source = decision.source;
    if (syncedSource && syncedSource !== source) {
      return {
        status: 'source-change-blocked',
        source,
        syncedSource,
        sources: decision.sources,
      };
    }
    // Track provenance separately from the user's source preference. In auto
    // mode ntBodySource intentionally remains empty so a later second source
    // becomes an ambiguity instead of silently pinning the first provider.
    // Set the safety marker before writes so a partial failure cannot make a
    // subsequent run switch providers and mix mapped fields.
    // Persist both provenance markers on the server before the first body
    // range read/write. The regular settings store is debounced, so relying
    // on set() alone would leave a crash window where imported data existed
    // without its connection/source marker.
    if (!syncedConnectionIdentity && !syncedSource) {
      await api.saveSetting('ntBodySyncedConnectionIdentity', connectionIdentity);
      if (s.ntBodySyncedConnectionIdentity?.set) s.ntBodySyncedConnectionIdentity.set(connectionIdentity);
      await api.saveSetting('ntBodySyncedSource', source);
      if (s.ntBodySyncedSource?.set) s.ntBodySyncedSource.set(source);
    } else if (syncedConnectionIdentity && !syncedSource) {
      // Recover safely if the connection marker persisted but the source
      // marker did not (for example, a failed second provenance save).
      await api.saveSetting('ntBodySyncedSource', source);
      if (s.ntBodySyncedSource?.set) s.ntBodySyncedSource.set(source);
    }
    const sourceMeasurements = response.measurements.filter(m => m.source === source);
    const unit = String(settingValue(s.weightUnit) || 'lbs');
    const existingRows = await api.getBodyStatsRange(start, end);
    if (!Array.isArray(existingRows)) throw new Error('LiftTrace returned malformed body stats');
    const existingByDate = new Map(existingRows.map(row => [row.date, row.stats || {}]));
    let writes = 0;
    for (const measurement of sourceMeasurements) {
      const mapped = mapNtObservationToLt(measurement, unit);
      const changed = changedMappedStats(existingByDate.get(measurement.date), mapped.stats);
      if (Object.keys(changed).length === 0) continue;
      await api.saveBodyStats(measurement.date, { stats: changed });
      writes += 1;
    }

    const newest = newestWeightMeasurement(sourceMeasurements);
    const newestWeightKg = newest ? finiteNumber(newest.metrics.weight_kg) : null;
    if (newestWeightKg != null && s.currentWeightKg?.set) s.currentWeightKg.set(newestWeightKg);
    if (s.ntBodyLastSyncAt?.set) s.ntBodyLastSyncAt.set(now);
    if (writes > 0 && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('lt:body-stats-saved'));
    }
    return {
      status: 'ok',
      source,
      sources: decision.sources,
      writes,
      currentWeightKg: newestWeightKg,
    };
  } catch (error) {
    return { status: 'error', error: error?.message || 'Body sync failed' };
  }
}

/**
 * Shared manual/automatic sync entry point. Concurrent lifecycle events and
 * a user click join the same operation rather than issuing duplicate reads or
 * writes. The next caller can start only after the current operation settles.
 */
export function syncNtBodyMeasurements(options = {}) {
  if (inFlight) return inFlight;
  inFlight = _syncNtBodyMeasurements(options).finally(() => {
    inFlight = null;
  });
  return inFlight;
}
