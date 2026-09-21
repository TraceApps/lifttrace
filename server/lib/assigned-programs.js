/**
 * Assigning a program to an athlete writes a `program_assignments` row and
 * nothing else: the program and its workouts are untouched, so their
 * `updated_at` stays whatever it was when the coach last edited them.
 *
 * `/api/sync/pull` is differential (`WHERE updated_at >= since`), so an
 * athlete's device received the assignment and not the plan it points at.
 * On Android the Programs tab reads the device's own copy (it is one of the
 * local-first GETs), so the program was simply absent: no sessions to pick,
 * nothing on the Diary's quick-start card, while prescribed workouts kept
 * arriving because each of those is a new row. It only worked when the coach
 * happened to build the program shortly before assigning it.
 *
 * The plan travels with the assignment instead. Any assignment in a pull
 * brings its program and that program's workouts along, whatever their
 * timestamps say.
 */

/**
 * Append the programs and templates referenced by `assignments` that the
 * differential queries did not already return. Mutates and returns both
 * arrays, so the caller can keep passing the same references into the
 * response.
 *
 * @param {object} db            better-sqlite3 (or compatible) handle
 * @param {object} p
 * @param {Array}  p.assignments program_assignments rows in this pull
 * @param {Array}  p.programs    programs rows already collected
 * @param {Array}  p.templates   workout_templates rows already collected
 * @param {Function} [p.parseRow] row post-processor (JSON columns)
 */
export function attachAssignedPrograms(db, { assignments, programs, templates, parseRow = (r) => r }) {
  const programIds = [...new Set((assignments || []).map(a => a.program_id).filter(id => id != null))];
  if (!programIds.length) return { programs, templates };

  const placeholders = programIds.map(() => '?').join(',');

  const havePrograms = new Set(programs.map(p => p.id));
  const missingIds = programIds.filter(id => !havePrograms.has(id));
  if (missingIds.length) {
    const rows = db.prepare(
      `SELECT * FROM programs WHERE id IN (${missingIds.map(() => '?').join(',')})`
    ).all(...missingIds);
    for (const row of rows) programs.push(parseRow(row));
  }

  // Templates are what the athlete actually picks a session from, so a
  // program without them is as useless as no program at all.
  const haveTemplates = new Set(templates.map(t => t.id));
  const rows = db.prepare(
    `SELECT * FROM workout_templates WHERE program_id IN (${placeholders})`
  ).all(...programIds);
  for (const row of rows) {
    if (!haveTemplates.has(row.id)) templates.push(parseRow(row));
  }

  return { programs, templates };
}
