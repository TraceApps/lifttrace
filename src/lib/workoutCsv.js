/**
 * workoutCsv.js — convert a completed workout into a CSV blob and
 * deliver it via download (PWA) or device storage + Share sheet (Android).
 *
 * One row per set so the file is easy to feed into a spreadsheet or any
 * analysis pipeline that expects long-format data. Unilateral exercises
 * that recorded left + right reps separately get one row each so the
 * sides aren't averaged away.
 *
 * Columns (stable order — downstream tools depend on this):
 *   date, workout, exercise, exercise_index, superset, set_index,
 *   warmup, reps, weight, weight_unit, side, rpe, completed,
 *   set_notes, exercise_notes, workout_notes, workout_duration_min
 *
 * `weight_unit` reflects the user's active unit preference at export
 * time (the underlying value is stored in that unit; we don't reconvert).
 */

import { isNative } from './platform.js';

function _escape(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function _row(values) {
  return values.map(_escape).join(',');
}

/**
 * @param {Object} workout — { name, date, notes, duration_min, exercises[] }
 * @param {'kg'|'lbs'} weightUnit
 * @returns {{ csv: string, filename: string }}
 */
/**
 * Third arg (optional): a Map / plain object of `{ exercise_id → library
 * load_type }`. When passed, per-exercise load_type resolves through the
 * full chain (per-instance → library → 'bilateral') and unilateral sets
 * without an explicit L/R split get emitted as two rows so the CSV
 * total matches what Statistics reports. When not passed, behavior
 * falls back to reading only `exercise.load_type` (per-instance override)
 * — matches pre-issue-#24 semantics for any caller that hasn't been
 * updated yet.
 */
export function workoutToCsv(workout, weightUnit = 'lbs', libraryLoadTypes) {
  const header = [
    'date', 'workout', 'exercise', 'exercise_index', 'superset',
    'set_index', 'warmup', 'reps', 'weight', 'weight_unit', 'side',
    'rpe', 'completed', 'set_notes', 'exercise_notes', 'workout_notes',
    'workout_duration_min',
  ];
  const lines = [_row(header)];

  const date = workout?.date || '';
  const wName = workout?.name || '';
  const wNotes = workout?.notes || '';
  const wDur = workout?.duration_min || '';

  const _getLib = (id) => {
    if (!libraryLoadTypes || id == null) return null;
    if (typeof libraryLoadTypes.get === 'function') return libraryLoadTypes.get(id) || null;
    return libraryLoadTypes[id] || null;
  };

  (workout?.exercises || []).forEach((ex, exIdx) => {
    const exName = ex.name || '';
    const exNotes = ex.notes || '';
    const superset = ex.superset_id || '';
    // Resolve load_type through per-instance → library default →
    // 'bilateral'. Client-side per-user pref is deliberately excluded
    // from the export so shared CSVs report the shared truth.
    const loadType = ex.load_type || _getLib(ex.exercise_id) || 'bilateral';
    (ex.sets || []).forEach((set, setIdx) => {
      const baseCols = [
        date, wName, exName, exIdx + 1, superset, setIdx + 1,
        set.warmup ? 'true' : 'false',
      ];
      const tailCols = [
        weightUnit,
        '', // side filled per-row below
        set.rpe ?? '',
        set.completed ? 'true' : 'false',
        set.notes || '',
        exNotes,
        wNotes,
        wDur,
      ];

      // Unilateral split: emit one row per side so neither L nor R is lost.
      const isSplit = (set.reps_l != null || set.reps_r != null);
      if (isSplit) {
        if (set.reps_l != null) {
          lines.push(_row([...baseCols, set.reps_l ?? '', set.weight ?? '', ...withSide(tailCols, 'L')]));
        }
        if (set.reps_r != null) {
          lines.push(_row([...baseCols, set.reps_r ?? '', set.weight ?? '', ...withSide(tailCols, 'R')]));
        }
      } else if (loadType === 'unilateral' && set.reps != null) {
        // Load-type-driven expansion: an alternating set logged as a
        // single `reps` value represents `reps` per side (5+5, not just
        // 5 total). Emit two rows so downstream totals reconcile with
        // Statistics' volume math.
        lines.push(_row([...baseCols, set.reps ?? '', set.weight ?? '', ...withSide(tailCols, 'L')]));
        lines.push(_row([...baseCols, set.reps ?? '', set.weight ?? '', ...withSide(tailCols, 'R')]));
      } else {
        lines.push(_row([...baseCols, set.reps ?? '', set.weight ?? '', ...tailCols]));
      }
    });
  });

  const csv = lines.join('\r\n') + '\r\n';
  const safeName = (wName || 'workout').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'workout';
  const filename = `lifttrace-${date || 'untitled'}-${safeName}.csv`;
  return { csv, filename };
}

function withSide(tail, side) {
  const copy = [...tail];
  copy[1] = side;
  return copy;
}

/**
 * Deliver the CSV to the user — direct download on PWA, write-to-device +
 * Share intent on Android (so they can pipe it into Drive / email / a
 * file manager from the system sheet).
 */
export async function exportWorkoutCsv(workout, weightUnit = 'lbs', libraryLoadTypes) {
  const { csv, filename } = workoutToCsv(workout, weightUnit, libraryLoadTypes);

  if (isNative) {
    const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem');
    const { Share } = await import('@capacitor/share');
    const dir = 'lifttrace-exports';
    try { await Filesystem.mkdir({ path: dir, directory: Directory.Cache, recursive: true }); } catch {}
    const path = `${dir}/${filename}`;
    const writeRes = await Filesystem.writeFile({
      path,
      data: csv,
      directory: Directory.Cache,
      encoding: Encoding.UTF8,
    });
    try {
      await Share.share({
        title: 'LiftTrace workout',
        text: filename,
        url: writeRes?.uri,
        dialogTitle: 'Save workout CSV',
      });
    } catch {
      // User dismissed the share sheet — the file is still on device.
    }
    return;
  }

  // PWA: trigger a direct download via a synthetic <a>.
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke after the click handler is done.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
