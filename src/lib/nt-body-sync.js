/**
 * NutriTrace body-measurement sync.
 *
 * The pure helpers keep source selection and field mapping independent from
 * the Settings screen. The orchestration deliberately writes partial body
 * stats through the existing API so manual circumference measurements stay
 * untouched.
 *
 * Two different owners can otherwise take over an operation that is already
 * running:
 *
 *   - the signed-in LiftTrace account (sign-out / sign-in): every side effect
 *     is checked against the account captured before the first await, so an
 *     import that starts as A and resumes as B writes nothing into B;
 *   - the verified NutriTrace connection (the Settings transition): it is
 *     checked before each import read and write, and a transition is queued
 *     against a running import rather than published underneath it.
 *
 * The provenance itself is fixed on the server by an atomic claim
 * (server/lib/nt-body-provenance.js), not by comparing a local marker and then
 * writing it: two tabs both see an empty marker, so only the server can decide
 * which source wins, and every imported measurement is written with that claim.
 */
import { LtApi } from './api.js';
import { captureNtAccount, ntAccountChanged, runNtExclusive } from './nt-sync-coordination.js';

const LB_PER_KG = 2.2046226218;
const SYNC_WINDOW_DAYS = 90;
// Ranges a real measurement can fall in. A value outside one is absent
// data, not a measurement: scales and exports use 0 for "no reading".
const MAX_WEIGHT_KG = 700;
const MAX_BODY_FAT_PCT = 100;
export const BODY_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;

let inFlight = null;

/**
 * A measurement value, or null when there isn't one. `Number(null)`,
 * `Number('')` and `Number(false)` are all 0, which used to be written as a
 * 0 kg weigh-in or 0% body fat. Structures are refused the same way; a
 * non-empty numeric string from an export is still accepted.
 */
function measurementNumber(value, max) {
  let n;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && value.trim() !== '') n = Number(value);
  else return null;
  return Number.isFinite(n) && n > 0 && n <= max ? n : null;
}

const weightKg = value => measurementNumber(value, MAX_WEIGHT_KG);
const bodyFatPct = value => measurementNumber(value, MAX_BODY_FAT_PCT);

function hasSupportedMetric(measurement) {
  const metrics = measurement?.metrics;
  return weightKg(metrics?.weight_kg) != null || bodyFatPct(metrics?.body_fat_pct) != null;
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
  const kg = weightKg(measurement?.metrics?.weight_kg);
  const bodyFat = bodyFatPct(measurement?.metrics?.body_fat_pct);
  if (kg != null) {
    stats.weight = unit === 'kg'
      ? kg
      : Math.round(kg * LB_PER_KG * 100) / 100;
  }
  if (bodyFat != null) stats.bodyFat = bodyFat;
  return { stats, weightKg: kg };
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
    .filter(m => hasSupportedMetric(m) && weightKg(m?.metrics?.weight_kg) != null)
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
  const instanceUrl = typeof value.instanceUrl === 'string' ? value.instanceUrl.replace(/\/+$/, '') : '';
  const userId = value.userId == null ? '' : String(value.userId);
  if (!instanceUrl || !userId) return null;
  // The revision ties the identity to the saved credentials. It stays in the
  // cache so a later connection transition can name the connection it was
  // based on (the server refuses to overwrite a newer one).
  const revision = typeof value.revision === 'string' && value.revision ? value.revision : null;
  return revision ? { instanceUrl, userId, revision } : { instanceUrl, userId };
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
 * The operation no longer belongs to the account or connection it started
 * under. Nothing was written; this is a cancellation, not a failure.
 */
function cancelled(code) {
  const error = new Error(code === 'account-changed'
    ? 'The signed-in account changed during the NutriTrace body sync.'
    : 'The NutriTrace connection changed during the body sync.');
  error.code = code;
  return error;
}

/**
 * Re-checks, before a side effect, that the operation still belongs to the
 * account and connection it was started with. One guard per operation, so a
 * write can never act on the settings of the account that replaced it.
 */
function createGuard({ account, settings: s, connectionIdentity }) {
  return {
    check() {
      if (ntAccountChanged(account)) throw cancelled('account-changed');
      const store = s?.ntConnectionIdentity;
      // A harness may omit the store; a real one always has it, and a cleared
      // or replaced identity must stop the import before it writes.
      if (store && typeof store.get === 'function' && !sameConnectionIdentity(settingValue(store), connectionIdentity)) {
        throw cancelled('connection-changed');
      }
    },
  };
}

function claimedProvenance(claim, { connectionIdentity, source }) {
  const fixed = {
    instanceUrl: connectionIdentity.instanceUrl,
    userId: connectionIdentity.userId,
    source,
  };
  const echoed = claim?.provenance;
  if (!echoed || !sameConnectionIdentity(echoed, fixed) ||
      String(echoed.source || '') !== source) {
    throw new Error('The server did not confirm the body provenance claim');
  }
  return fixed;
}

/**
 * Sync the selected NutriTrace source into LiftTrace body stats.
 * `manual` bypasses the six-hour foreground throttle but remains opt-in for
 * automatic runs. Errors are returned rather than thrown for silent callers.
 */
async function _syncNtBodyMeasurements({ manual = false, api = LtApi, settings, now = Date.now(), account } = {}) {
  const owner = account || captureNtAccount();
  try {
    // The queue may have handed this operation over after the phone changed
    // hands; then not even a read belongs to it.
    if (ntAccountChanged(owner)) return { status: 'account-changed' };
    const s = settings || await defaultSettings();
    if (!settingValue(s.ntFederationEnabled) || (!manual && !settingValue(s.ntBodySyncEnabled))) {
      return { status: 'disabled' };
    }

    const connectionIdentity = stableConnectionIdentity(settingValue(s.ntConnectionIdentity));
    if (!connectionIdentity) {
      return { status: 'connection-verification-required' };
    }
    const guard = createGuard({ account: owner, settings: s, connectionIdentity });
    // The account may already have changed while this operation waited for a
    // running connection transition, in which case even a read belongs to
    // somebody else.
    guard.check();

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
    // The proxy reads with the connection the server has saved *now*. It is
    // checked again below, and the claim that follows names the connection
    // this import is attributed to, so a connection change in this window is
    // refused rather than mislabelled.
    guard.check();
    const response = await api.getNtBodyComposition(start, end, selectedSource || undefined);
    validResponse(response?.measurements);
    // The receipt names the connection this read was answered with. Without it
    // the claim cannot be tied to these measurements, so the import stops
    // before anything is attributed.
    const readId = typeof response?.readId === 'string' ? response.readId : '';
    if (!readId) return { status: 'read-receipt-required' };

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
      guard.check();
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
    // Fix provenance on the server before the first write. This is a
    // compare-and-set, not a read-then-write: two tabs opened before the first
    // import both see an empty local marker, and exactly one claim wins. The
    // local stores only cache the answer, so a crash cannot leave imported
    // data without its marker.
    guard.check();
    let claim;
    try {
      claim = await api.claimNtBodyProvenance({ connectionIdentity, source, readId });
    } catch (error) {
      if (error?.code === 'source-provenance-conflict') {
        return {
          status: 'source-change-blocked',
          source,
          syncedSource: String(error.provenance?.source || syncedSource),
          sources: decision.sources,
        };
      }
      if (error?.code === 'connection-provenance-conflict' || error?.code === 'connection-mismatch' ||
          error?.code === 'read-receipt-missing' || error?.code === 'read-identity-mismatch') {
        return { status: 'connection-change-blocked', syncedSource };
      }
      throw error;
    }
    const provenance = claimedProvenance(claim, { connectionIdentity, source });
    // The claim may have taken a while: do not cache it into the local copy of
    // an account that signed in meanwhile (these setters persist per account).
    guard.check();
    if (s.ntBodySyncedConnectionIdentity?.set) s.ntBodySyncedConnectionIdentity.set(connectionIdentity);
    if (s.ntBodySyncedSource?.set) s.ntBodySyncedSource.set(source);

    // Track provenance separately from the user's source preference. In auto
    // mode ntBodySource intentionally remains empty so a later second source
    // becomes an ambiguity instead of silently pinning the first provider.
    const sourceMeasurements = response.measurements.filter(m => m.source === source);
    const unit = String(settingValue(s.weightUnit) || 'lbs');
    guard.check();
    const existingRows = await api.getBodyStatsRange(start, end);
    if (!Array.isArray(existingRows)) throw new Error('LiftTrace returned malformed body stats');
    const existingByDate = new Map(existingRows.map(row => [row.date, row.stats || {}]));
    let writes = 0;
    for (const measurement of sourceMeasurements) {
      const mapped = mapNtObservationToLt(measurement, unit);
      const changed = changedMappedStats(existingByDate.get(measurement.date), mapped.stats);
      if (Object.keys(changed).length === 0) continue;
      // Every write is checked: an account or connection change part way
      // through the range must not move the rest of the history.
      guard.check();
      await api.saveBodyStats(measurement.date, { stats: changed, provenance });
      writes += 1;
    }

    const newest = newestWeightMeasurement(sourceMeasurements);
    const newestWeightKg = newest ? weightKg(newest.metrics.weight_kg) : null;
    guard.check();
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
    if (error?.code === 'account-changed') return { status: 'account-changed' };
    if (error?.code === 'connection-changed') return { status: 'connection-change-blocked' };
    return { status: 'error', error: error?.message || 'Body sync failed' };
  }
}

/**
 * Shared manual/automatic sync entry point. Concurrent lifecycle events and
 * a user click join the same operation rather than issuing duplicate reads or
 * writes. The next caller can start only after the current operation settles.
 * The operation also queues behind a NutriTrace connection transition, and the
 * account is captured now: if it changes before the queue reaches this
 * operation, it is cancelled instead of importing into the next account.
 */
export function syncNtBodyMeasurements(options = {}) {
  if (inFlight) return inFlight;
  const account = options.account || captureNtAccount();
  inFlight = runNtExclusive(() => _syncNtBodyMeasurements({ ...options, account }))
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}
