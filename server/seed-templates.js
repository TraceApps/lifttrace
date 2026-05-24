import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import db from './db.js';
import { logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Seeds generic starter program templates on first boot.
 * These are standard training splits that any lifter can use as a starting point.
 */
export function seedPrograms() {
  const count = db.prepare('SELECT COUNT(*) as c FROM programs').get().c;
  if (count > 0) return; // already have programs

  const STARTER_PROGRAMS = [
    {
      name: 'Push / Pull / Legs',
      description: 'Classic 3-day split. Each workout targets pushing muscles, pulling muscles, or legs. Run 3-6 days per week.',
      goal: 'general',
      templates: [
        { name: 'Push Day', day_label: 'Push', exercises: [
          { exercise_name: 'Bench Press', target_sets: 4, target_reps: '8-10' },
          { exercise_name: 'Overhead Press', target_sets: 3, target_reps: '8-10' },
          { exercise_name: 'Incline Dumbbell Press', target_sets: 3, target_reps: '10-12' },
          { exercise_name: 'Lateral Raise', target_sets: 3, target_reps: '12-15' },
          { exercise_name: 'Tricep Pushdown', target_sets: 3, target_reps: '10-12' },
        ]},
        { name: 'Pull Day', day_label: 'Pull', exercises: [
          { exercise_name: 'Barbell Row', target_sets: 4, target_reps: '8-10' },
          { exercise_name: 'Pull-ups', target_sets: 3, target_reps: '6-10' },
          { exercise_name: 'Face Pull', target_sets: 3, target_reps: '12-15' },
          { exercise_name: 'Bicep Curl', target_sets: 3, target_reps: '10-12' },
          { exercise_name: 'Hammer Curl', target_sets: 3, target_reps: '10-12' },
        ]},
        { name: 'Leg Day', day_label: 'Legs', exercises: [
          { exercise_name: 'Squat', target_sets: 4, target_reps: '6-8' },
          { exercise_name: 'Romanian Deadlift', target_sets: 3, target_reps: '8-10' },
          { exercise_name: 'Leg Press', target_sets: 3, target_reps: '10-12' },
          { exercise_name: 'Leg Curl', target_sets: 3, target_reps: '10-12' },
          { exercise_name: 'Calf Raise', target_sets: 4, target_reps: '12-15' },
        ]},
      ],
    },
    {
      name: 'Upper / Lower',
      description: '4-day split alternating upper and lower body. Great balance of volume and recovery.',
      goal: 'general',
      templates: [
        { name: 'Upper A', day_label: 'Upper', exercises: [
          { exercise_name: 'Bench Press', target_sets: 4, target_reps: '6-8' },
          { exercise_name: 'Barbell Row', target_sets: 4, target_reps: '6-8' },
          { exercise_name: 'Overhead Press', target_sets: 3, target_reps: '8-10' },
          { exercise_name: 'Lat Pulldown', target_sets: 3, target_reps: '10-12' },
          { exercise_name: 'Bicep Curl', target_sets: 2, target_reps: '10-12' },
          { exercise_name: 'Tricep Extension', target_sets: 2, target_reps: '10-12' },
        ]},
        { name: 'Lower A', day_label: 'Lower', exercises: [
          { exercise_name: 'Squat', target_sets: 4, target_reps: '6-8' },
          { exercise_name: 'Romanian Deadlift', target_sets: 3, target_reps: '8-10' },
          { exercise_name: 'Leg Press', target_sets: 3, target_reps: '10-12' },
          { exercise_name: 'Leg Curl', target_sets: 3, target_reps: '10-12' },
          { exercise_name: 'Calf Raise', target_sets: 4, target_reps: '12-15' },
        ]},
      ],
    },
    {
      name: 'Full Body 3x',
      description: '3 full-body workouts per week. Ideal for beginners or those with limited training days.',
      goal: 'general',
      templates: [
        { name: 'Workout A', day_label: 'Day A', exercises: [
          { exercise_name: 'Squat', target_sets: 3, target_reps: '8-10' },
          { exercise_name: 'Bench Press', target_sets: 3, target_reps: '8-10' },
          { exercise_name: 'Barbell Row', target_sets: 3, target_reps: '8-10' },
          { exercise_name: 'Overhead Press', target_sets: 2, target_reps: '10-12' },
          { exercise_name: 'Bicep Curl', target_sets: 2, target_reps: '10-12' },
        ]},
        { name: 'Workout B', day_label: 'Day B', exercises: [
          { exercise_name: 'Deadlift', target_sets: 3, target_reps: '6-8' },
          { exercise_name: 'Incline Press', target_sets: 3, target_reps: '8-10' },
          { exercise_name: 'Pull-ups', target_sets: 3, target_reps: '6-10' },
          { exercise_name: 'Lateral Raise', target_sets: 3, target_reps: '12-15' },
          { exercise_name: 'Tricep Extension', target_sets: 2, target_reps: '10-12' },
        ]},
      ],
    },
  ];

  const insertProg = db.prepare('INSERT INTO programs (name, description, goal, visibility) VALUES (?, ?, ?, ?)');
  const insertTmpl = db.prepare('INSERT INTO workout_templates (program_id, name, day_label, order_index, exercises) VALUES (?, ?, ?, ?, ?)');

  for (const prog of STARTER_PROGRAMS) {
    const result = insertProg.run(prog.name, prog.description, prog.goal, 'shared');
    const progId = result.lastInsertRowid;
    prog.templates.forEach((t, i) => {
      insertTmpl.run(progId, t.name, t.day_label, i, JSON.stringify(t.exercises));
    });
  }

  logger.info(`[seed] Seeded ${STARTER_PROGRAMS.length} starter program templates`);
  return;

  let data;
  try {
    const raw = readFileSync(path.join(__dirname, 'seed-programs.json'), 'utf8');
    data = JSON.parse(raw);
  } catch (e) {
    logger.warn('[seed] seed-programs.json not found or invalid — skipping');
    return;
  }

  const insertProgram = db.prepare(
    'INSERT INTO programs (name, description, goal, visibility) VALUES (?, ?, ?, ?)'
  );
  const insertTemplate = db.prepare(
    'INSERT INTO workout_templates (program_id, name, day_label, order_index, exercises) VALUES (?, ?, ?, ?, ?)'
  );

  let totalTemplates = 0;

  db.transaction(() => {
    for (const prog of data.programs || []) {
      const result = insertProgram.run(
        prog.name,
        prog.description || null,
        prog.goal || 'general',
        'shared' // shared so all users can see them
      );
      const programId = result.lastInsertRowid;

      for (let i = 0; i < (prog.templates || []).length; i++) {
        const tpl = prog.templates[i];
        insertTemplate.run(
          programId,
          tpl.name,
          tpl.name,  // day_label = same as name
          i,
          JSON.stringify(tpl.exercises)
        );
        totalTemplates++;
      }
    }
  })();

  logger.info(`[seed] Seeded ${data.programs.length} programs with ${totalTemplates} workout templates`);
}
