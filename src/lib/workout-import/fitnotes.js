import { parseCsv, convertWeight } from './common.js';

/**
 * FitNotes CSV export (popular free Android app).
 *
 * Two header shapes exist in the wild:
 *   Date,Exercise,Category,Weight (kgs),Reps,Distance,Distance Unit,Time,Comment
 *   Date,Exercise,Category,Weight,Weight Unit,Reps,Distance,Distance Unit,Time
 *
 * Notes:
 *   - The unit arrives either in the weight column's own name or in a
 *     separate per-row column. Both are read; see _fitnotesUnit below.
 *   - The date is written in the phone's locale, so it is not always ISO.
 *     See _detectDateOrder below.
 *   - No workout-name column. FitNotes organizes purely by date, so every
 *     imported workout for a given day lands as one workout_log row named
 *     by the trained muscle categories (e.g. "Chest / Back").
 *   - One row per set. Comma-delimited.
 */
export function parseFitnotes(csvText, userUnit) {
  const rows = parseCsv(csvText, ',');
  if (rows.length === 0) return [];

  // The weight column, and the unit that goes with it. Reading only the
  // header meant an export using the separate-column form was treated as
  // pounds whatever it actually said, so every weight was divided by
  // 2.20462: a 74.6 kg bench came in as 33.84. Reported on r/selfhosted
  // with the file that proved it.
  const headerKeys = Object.keys(rows[0]);
  const weightKey = headerKeys.find(k => /^weight\b/i.test(k) && !/\bunit\b/i.test(k)) || 'weight';
  const unitKey = headerKeys.find(k => /weight/i.test(k) && /\bunit\b/i.test(k)) || null;
  const headerMatch = weightKey.match(/\(([^)]+)\)/);
  const headerUnit = headerMatch ? _fitnotesUnit(headerMatch[1]) : null;

  const dateOrder = _detectDateOrder(rows);

  const byDate = new Map();
  for (const row of rows) {
    const date = _fitnotesDate(row['date'], dateOrder);
    if (!date) continue;

    const exName = (row['exercise'] || '').trim();
    if (!exName) continue;
    const category = (row['category'] || '').trim();
    const reps = parseInt(row['reps'] || '0', 10) || 0;
    // Per row, because a single export can mix units: FitNotes stores the
    // unit against the exercise, not the account.
    const sourceUnit = (unitKey && _fitnotesUnit(row[unitKey])) || headerUnit || 'lbs';
    const weight = convertWeight(row[weightKey] || '0', sourceUnit, userUnit);
    // Timed set (issue #89): FitNotes records holds in its Time column
    // ("h:mm:ss", "mm:ss" or plain seconds). Timed only with no reps, the
    // same rule the Strong and Hevy importers use.
    const seconds = _fitnotesSeconds(row['time']);
    const timed = seconds > 0 && reps === 0;
    const comment = (row['comment'] || '').trim();

    if (!byDate.has(date)) byDate.set(date, { categories: new Set(), exercises: new Map() });
    const day = byDate.get(date);
    if (category) day.categories.add(category);
    if (!day.exercises.has(exName)) day.exercises.set(exName, []);
    day.exercises.get(exName).push({ reps, weight, completed: true, notes: comment, rpe: null, ...(timed ? { duration_sec: seconds } : {}) });
  }

  const out = [];
  for (const [date, day] of byDate) {
    const cats = [...day.categories].slice(0, 3);
    const name = cats.length ? cats.join(' / ') : 'Workout';
    const exercises = [...day.exercises.entries()].map(([exName, sets]) => ({
      sourceName: exName,
      exercise_id: null,
      exercise_name: exName,
      superset_id: null,
      superset_size: 1,
      sets,
      ...(sets.length && sets.every(s => s.duration_sec > 0) ? { set_type: 'time' } : {}),
    }));
    out.push({ date, name, notes: '', duration_min: null, exercises });
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

/** "kgs", "kg", "Kilograms" -> 'kg'; "lbs", "lb" -> 'lbs'; anything else null. */
function _fitnotesUnit(raw) {
  const t = String(raw || '').trim().toLowerCase();
  if (t.startsWith('kg')) return 'kg';
  if (t.startsWith('lb')) return 'lbs';
  return null;
}

/** Split a date into its three numbers, or null if it is not a date at all. */
function _splitDate(raw) {
  const t = String(raw || '').trim().split(/[ T]/)[0];
  const m = t.match(/^(\d{1,4})[/.-](\d{1,2})[/.-](\d{1,4})$/);
  if (!m) return null;
  const [, x, y, z] = m;
  if (x.length === 4) return { iso: true, y: +x, m: +y, d: +z };
  if (z.length <= 2 || z.length === 4) return { iso: false, a: +x, b: +y, y: z.length === 4 ? +z : 2000 + +z };
  return null;
}

/**
 * FitNotes writes the date in the phone's locale, so an export from a
 * Spanish or German phone reads 23/12/2025 where an English one reads
 * 2025-12-23. The parser used to require ISO and skip every other row,
 * which turned a localized export into an import of nothing.
 *
 * Day-first and month-first cannot be told apart one row at a time, since
 * 03/04/2025 is legal either way, so the whole file decides: a first number
 * above 12 proves day-first, a second number above 12 proves month-first.
 * A file that proves neither is read day-first, which is what every locale
 * writing slashes outside the US uses, and is also the only order that can
 * produce a non-ISO FitNotes export in the first place on a phone set to
 * one of them. A file that somehow proves both is day-first too: something
 * is wrong with it either way, and guessing consistently beats guessing per
 * row.
 */
function _detectDateOrder(rows) {
  let dayFirst = false;
  let monthFirst = false;
  for (const row of rows) {
    const p = _splitDate(row['date']);
    if (!p || p.iso) continue;
    if (p.a > 12) dayFirst = true;
    if (p.b > 12) monthFirst = true;
  }
  return monthFirst && !dayFirst ? 'mdy' : 'dmy';
}

/** One date value to 'YYYY-MM-DD', or '' if it is not usable. */
function _fitnotesDate(raw, order) {
  const p = _splitDate(raw);
  if (!p) return '';
  const y = p.y;
  const m = p.iso ? p.m : (order === 'mdy' ? p.a : p.b);
  const d = p.iso ? p.d : (order === 'mdy' ? p.b : p.a);
  if (!(y >= 1900 && y <= 2999) || !(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return '';
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function _fitnotesSeconds(raw) {
  const t = String(raw || '').trim();
  if (!t) return 0;
  if (/^\d+(:\d{1,2}){1,2}$/.test(t)) return t.split(':').map(Number).reduce((a, p) => a * 60 + p, 0);
  const n = Math.round(parseFloat(t));
  return Number.isFinite(n) && n > 0 ? n : 0;
}
