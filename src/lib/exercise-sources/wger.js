// Shared fetcher + row builder for the wger public catalog.
// Isomorphic: works on the server (Node) using the standard `fetch`, and on
// the native Android client via CapacitorHttp — pass whichever `fetchFn`
// suits the environment. Both callers do their own INSERT loop with the
// returned rows (better-sqlite3 on the server, @capacitor-community/sqlite
// on native), so the schema-writing side stays platform-native and this
// module carries only the wger-specific fetch/parse.

const API_URL = 'https://wger.de/api/v2/exerciseinfo/?format=json&language=2';

const CATEGORY_MAP = {
  8: 'arms', 9: 'legs', 10: 'core', 11: 'chest',
  12: 'back', 13: 'shoulders', 14: 'legs', 15: 'cardio',
};
const EQUIPMENT_MAP = {
  1: 'Barbell', 2: 'Barbell', 3: 'Dumbbell', 4: 'Other', 5: 'Other',
  6: 'Bodyweight', 7: 'Bodyweight', 8: 'Machine', 9: 'Machine', 10: 'Kettlebell',
};
const MUSCLE_MAP = {
  1: 'Biceps brachii', 2: 'Anterior deltoid', 3: 'Serratus anterior',
  4: 'Pectoralis major', 5: 'Triceps brachii', 6: 'Rectus abdominis',
  7: 'Gastrocnemius', 8: 'Gluteus maximus', 9: 'Trapezius',
  10: 'Quadriceps femoris', 11: 'Hamstrings', 12: 'Latissimus dorsi',
  13: 'Brachialis', 14: 'Obliquus externus', 15: 'Soleus',
};

/**
 * Fetch every wger exercise (English translation) and reduce each to the
 * canonical LT row shape. Paginated; ~600 exercises across ~6 pages.
 *
 * @param {object} [opts]
 * @param {(url: string) => Promise<{ok: boolean, status: number, json: () => Promise<any>}>} [opts.fetchFn]
 *   Fetch adapter. Node's global `fetch` on the server; a CapacitorHttp
 *   wrapper on native (see fetchHelper.js). Defaults to global `fetch`.
 * @returns {Promise<Array>} normalized rows ready for INSERT.
 */
export async function fetchWgerRows({ fetchFn = fetch } = {}) {
  const rows = [];
  const LIMIT = 100;
  let offset = 0;
  while (true) {
    const url = `${API_URL}&limit=${LIMIT}&offset=${offset}`;
    const res = await fetchFn(url);
    if (!res.ok) throw new Error(`wger returned ${res.status}`);
    const data = await res.json();
    for (const ex of data.results || []) {
      const en = ex.translations?.find(t => t.language === 2);
      if (!en?.name) continue;
      const primary = (ex.muscles || []).map(m => MUSCLE_MAP[m.id] || m.name_en || `Muscle ${m.id}`);
      const secondary = (ex.muscles_secondary || []).map(m => MUSCLE_MAP[m.id] || m.name_en || `Muscle ${m.id}`);
      const equipment = [...new Set((ex.equipment || []).map(e => EQUIPMENT_MAP[e.id] || 'Other'))];
      const img = ex.images?.find(i => i.is_main)?.image || ex.images?.[0]?.image || null;
      rows.push({
        name: en.name.trim(),
        category: CATEGORY_MAP[ex.category?.id] || 'other',
        primary_muscles: primary,
        secondary_muscles: secondary,
        equipment,
        instructions: en.description?.replace(/<[^>]+>/g, '') || null,
        img_url: img,
        gif_url: null,
        video_url: null,
        external_id: ex.id,
      });
    }
    if (!data.next) break;
    offset += LIMIT;
  }
  return rows;
}
