import db from '../db.js';
import { logger } from '../logger.js';

/**
 * yuhonas/free-exercise-db — public domain catalog with start/end position
 * images bundled in the repo. We hot-link the raw.githubusercontent.com URLs
 * (no API key, no rate limits in practice).
 *
 * JSON schema (per entry): {
 *   id, name, force, level, mechanic, equipment, primaryMuscles[],
 *   secondaryMuscles[], instructions[], category, images[]
 * }
 */
const JSON_URL  = 'https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/dist/exercises.json';
const IMAGE_BASE = 'https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/';

// Map primary muscle → body part category (matches our filter pills)
const MUSCLE_TO_CATEGORY = {
  'chest': 'chest', 'pectorals': 'chest',
  'middle back': 'back', 'lower back': 'back', 'lats': 'back', 'traps': 'back',
  'shoulders': 'shoulders', 'deltoids': 'shoulders',
  'biceps': 'arms', 'triceps': 'arms', 'forearms': 'arms',
  'quadriceps': 'legs', 'hamstrings': 'legs', 'glutes': 'legs', 'calves': 'legs',
  'adductors': 'legs', 'abductors': 'legs',
  'abdominals': 'core', 'obliques': 'core',
  'neck': 'shoulders',
};

function mapCategory(exerciseCategory, primaryMuscles) {
  // Cardio exercises override muscle-based mapping
  const lc = (exerciseCategory || '').toLowerCase();
  if (lc === 'cardio') return 'cardio';

  // Multi-muscle compound exercises → full_body
  if (primaryMuscles && primaryMuscles.length >= 3) return 'full_body';

  // Determine body part from primary muscle
  if (primaryMuscles && primaryMuscles.length > 0) {
    const muscle = primaryMuscles[0].toLowerCase();
    for (const [key, cat] of Object.entries(MUSCLE_TO_CATEGORY)) {
      if (muscle.includes(key)) return cat;
    }
  }

  // Fallback
  if (lc === 'stretching') return 'other';
  if (lc === 'plyometrics') return 'cardio';
  return 'other';
}

function titleCase(s) {
  return s.split(' ').map(w => w[0] ? w[0].toUpperCase() + w.slice(1) : w).join(' ');
}

export async function seedFromFreeDb() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  let data;
  try {
    const res = await fetch(JSON_URL, { signal: controller.signal });
    if (!res.ok) throw new Error(`free-db JSON returned ${res.status}`);
    data = await res.json();
  } finally {
    clearTimeout(timer);
  }

  const insert = db.prepare(
    `INSERT OR IGNORE INTO exercises
     (name, category, primary_muscles, secondary_muscles, equipment, instructions, img_url, gif_url, video_url, external_id, source, is_global)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'free-db', 1)`
  );

  let count = 0;
  for (const ex of data) {
    if (!ex.name) continue;

    // Image URLs: free-db ships 0.jpg (start) and 1.jpg (end). We pack the
    // start position in img_url and the end position in gif_url so the renderer
    // can swap between them on a CSS loop to fake an animation.
    const imgs = (ex.images || []).map(p => IMAGE_BASE + p);
    const img_url = imgs[0] || null;
    const gif_url = imgs[1] || null;

    const equipment = ex.equipment ? [titleCase(ex.equipment)] : [];
    const primary = (ex.primaryMuscles || []).map(titleCase);
    const secondary = (ex.secondaryMuscles || []).map(titleCase);
    const instructions = (ex.instructions || []).join('\n\n');

    insert.run(
      ex.name,
      mapCategory(ex.category, ex.primaryMuscles),
      JSON.stringify(primary),
      JSON.stringify(secondary),
      JSON.stringify(equipment),
      instructions || null,
      img_url, gif_url, null,
      null
    );
    count++;
  }
  logger.info(`[free-db] processed ${data.length}, inserted ${count}`);
  return count;
}
