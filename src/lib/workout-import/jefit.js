import { parseCsv, splitCsvLine, convertWeight } from './common.js';

/**
 * Jefit exports a few different formats. The one we target is the "Workout
 * Log" CSV accessible from Jefit web → Account → Export Data → Workout Log.
 *
 * Typical header (varies a bit by version):
 *   Log Date,Routine,Exercise,Set,Weight,Weight Unit,Reps,Notes
 *
 * Older exports sometimes use:
 *   Date,Exercise Name,Weight,Unit,Reps,Notes
 *
 * We read by best-matching header name rather than strict position, so
 * either layout works. Each CSV row is one set. Comma-delimited.
 *
 * Weight unit may be on the row (in a column) OR on the header itself
 * ("Weight (lbs)") — both handled.
 */
export function parseJefit(csvText, userUnit) {
  // Peek at the header to decide which flavor we're in.
  const raw = csvText.replace(/\r\n?/g, '\n');
  const firstLine = raw.split('\n', 1)[0];
  const headerCells = splitCsvLine(firstLine, ',').map(s => s.toLowerCase());

  // Build a field index
  const idx = (names) => {
    for (const n of names) {
      const i = headerCells.findIndex(h => h === n || h.startsWith(n + ' ') || h.startsWith(n + '('));
      if (i >= 0) return i;
    }
    return -1;
  };

  const dateIdx    = idx(['log date', 'date']);
  const routineIdx = idx(['routine', 'workout', 'workout name']);
  const exerciseIdx = idx(['exercise', 'exercise name']);
  const weightIdx  = idx(['weight']);
  const unitIdx    = idx(['weight unit', 'unit']);
  const repsIdx    = idx(['reps']);
  const notesIdx   = idx(['notes', 'comment']);

  if (dateIdx < 0 || exerciseIdx < 0 || weightIdx < 0 || repsIdx < 0) {
    throw new Error('Jefit CSV: could not identify required columns (date / exercise / weight / reps)');
  }

  // Detect unit from the header if the column "Weight" has a "(lbs)" or "(kgs)" suffix
  const weightHeader = headerCells[weightIdx] || '';
  const headerUnitMatch = weightHeader.match(/\(([^)]+)\)/);
  const headerUnit = headerUnitMatch
    ? (headerUnitMatch[1].toLowerCase().startsWith('kg') ? 'kg' : 'lbs')
    : null;

  // Parse each row positionally to sidestep duplicate header names
  const rows = raw.split('\n').slice(1).filter(l => l.trim()).map(l => splitCsvLine(l, ','));

  const byKey = new Map();
  for (const cols of rows) {
    const rawDate = (cols[dateIdx] || '').trim();
    const date = _parseJefitDate(rawDate);
    if (!date) continue;
    const routine = routineIdx >= 0 ? (cols[routineIdx] || '').trim() : '';
    const exName = (cols[exerciseIdx] || '').trim();
    if (!exName) continue;

    const rawWeight = (cols[weightIdx] || '0').trim();
    const rowUnit = unitIdx >= 0
      ? ((cols[unitIdx] || '').trim().toLowerCase().startsWith('kg') ? 'kg' : 'lbs')
      : (headerUnit || userUnit || 'lbs');
    const weight = convertWeight(rawWeight, rowUnit, userUnit);
    const reps = parseInt((cols[repsIdx] || '0').trim(), 10) || 0;
    const notes = notesIdx >= 0 ? (cols[notesIdx] || '').trim() : '';

    const workoutName = routine || 'Workout';
    const key = `${date}|${workoutName}`;
    if (!byKey.has(key)) byKey.set(key, { date, name: workoutName, exercises: new Map() });
    const w = byKey.get(key);
    if (!w.exercises.has(exName)) w.exercises.set(exName, []);
    w.exercises.get(exName).push({ reps, weight, completed: true, notes, rpe: null });
  }

  const out = [];
  for (const w of byKey.values()) {
    const exercises = [...w.exercises.entries()].map(([exName, sets]) => ({
      sourceName: exName,
      exercise_id: null,
      exercise_name: exName,
      superset_id: null,
      superset_size: 1,
      sets,
    }));
    out.push({ date: w.date, name: w.name, notes: '', duration_min: null, exercises });
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

// Jefit dates: "2024-08-01", "08/01/2024", or "Aug 1 2024"
function _parseJefitDate(raw) {
  if (!raw) return null;
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return iso[0];
  const us = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (us) return `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
  const months = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
                   Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
  const wd = raw.match(/([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4})/);
  if (wd) {
    const mon = months[wd[1][0].toUpperCase() + wd[1].slice(1, 3).toLowerCase()];
    if (mon) return `${wd[3]}-${mon}-${wd[2].padStart(2, '0')}`;
  }
  return null;
}
