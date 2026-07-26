// Shared fetcher + row builder for the Free Exercise DB (yuhonas), a public-
// domain catalog with start/end position images bundled in the repo.
// Isomorphic — see wger.js for the fetchFn convention.

const JSON_URL   = 'https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/dist/exercises.json';
const IMAGE_BASE = 'https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/';

// Primary-muscle → filter-pill category. Matches the taxonomy the LT
// Exercises page uses so imported rows filter cleanly out of the box.
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
  const lc = (exerciseCategory || '').toLowerCase();
  if (lc === 'cardio') return 'cardio';
  if (primaryMuscles && primaryMuscles.length >= 3) return 'full_body';
  if (primaryMuscles && primaryMuscles.length > 0) {
    const muscle = primaryMuscles[0].toLowerCase();
    for (const [key, cat] of Object.entries(MUSCLE_TO_CATEGORY)) {
      if (muscle.includes(key)) return cat;
    }
  }
  if (lc === 'stretching') return 'other';
  if (lc === 'plyometrics') return 'cardio';
  return 'other';
}

function titleCase(s) {
  return s.split(' ').map(w => w[0] ? w[0].toUpperCase() + w.slice(1) : w).join(' ');
}

export async function fetchFreeDbRows({ fetchFn = fetch } = {}) {
  const res = await fetchFn(JSON_URL);
  if (!res.ok) throw new Error(`free-db JSON returned ${res.status}`);
  const data = await res.json();
  const rows = [];
  for (const ex of data) {
    if (!ex.name) continue;
    // free-db ships 0.jpg (start) + 1.jpg (end). Pack start in img_url and
    // end in gif_url so the renderer can swap between them on a CSS loop
    // to fake an animation.
    const imgs = (ex.images || []).map(p => IMAGE_BASE + p);
    rows.push({
      name: ex.name,
      category: mapCategory(ex.category, ex.primaryMuscles),
      primary_muscles: (ex.primaryMuscles || []).map(titleCase),
      secondary_muscles: (ex.secondaryMuscles || []).map(titleCase),
      equipment: ex.equipment ? [titleCase(ex.equipment)] : [],
      instructions: (ex.instructions || []).join('\n\n') || null,
      img_url: imgs[0] || null,
      gif_url: imgs[1] || null,
      video_url: null,
      external_id: null,
    });
  }
  return rows;
}
