import db from '../db.js';
import { logger } from '../logger.js';

/**
 * ExerciseDB via RapidAPI. Requires the user to bring their own API key
 * (paid). We never proxy or store the key on disk except in user_settings.
 *
 * Endpoint: GET https://exercisedb.p.rapidapi.com/exercises?limit=1500
 * Returns ~1300 exercises with `gifUrl` pointing to a CDN-hosted animated GIF.
 *
 * NOTE: the GIFs themselves are commercial assets governed by ExerciseDB's
 * Terms of Use, not by any open license. Importing them stores only a URL
 * reference; the user must have a valid subscription for the URLs to load.
 */
const ENDPOINT = 'https://exercisedb.p.rapidapi.com/exercises?limit=1500&offset=0';

function mapCategory(bodyPart) {
  const m = {
    'back': 'back', 'cardio': 'cardio', 'chest': 'chest',
    'lower arms': 'arms', 'lower legs': 'legs',
    'neck': 'shoulders', 'shoulders': 'shoulders',
    'upper arms': 'arms', 'upper legs': 'legs', 'waist': 'core',
  };
  return m[(bodyPart || '').toLowerCase()] || 'other';
}

function titleCase(s) {
  if (!s) return s;
  return s.split(' ').map(w => w[0] ? w[0].toUpperCase() + w.slice(1) : w).join(' ');
}

export async function seedFromExerciseDb({ apiKey } = {}) {
  if (!apiKey) throw new Error('ExerciseDB requires a RapidAPI key');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  let data;
  try {
    const res = await fetch(ENDPOINT, {
      signal: controller.signal,
      headers: {
        'x-rapidapi-key': apiKey,
        'x-rapidapi-host': 'exercisedb.p.rapidapi.com',
      },
    });
    if (!res.ok) throw new Error(`ExerciseDB API returned ${res.status}`);
    data = await res.json();
  } finally {
    clearTimeout(timer);
  }

  const insert = db.prepare(
    `INSERT OR IGNORE INTO exercises
     (name, category, primary_muscles, secondary_muscles, equipment, instructions, gif_url, external_id, source, is_global)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'exercisedb', 1)`
  );

  let count = 0;
  for (const ex of data) {
    if (!ex.name) continue;
    const name = titleCase(ex.name);
    const category = mapCategory(ex.bodyPart);
    const primary = ex.target ? [titleCase(ex.target)] : [];
    const secondary = (ex.secondaryMuscles || []).map(titleCase);
    const equipment = ex.equipment ? [titleCase(ex.equipment)] : [];
    const instructions = Array.isArray(ex.instructions)
      ? ex.instructions.join('\n\n')
      : (ex.instructions || null);

    insert.run(
      name, category,
      JSON.stringify(primary),
      JSON.stringify(secondary),
      JSON.stringify(equipment),
      instructions,
      ex.gifUrl || null,
      ex.id || null
    );
    count++;
  }
  logger.info(`[exercisedb] processed ${data.length}, inserted ${count}`);
  return count;
}
