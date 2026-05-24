import db from '../db.js';
import { logger } from '../logger.js';

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

export async function seedFromWger() {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO exercises (name, category, primary_muscles, secondary_muscles, equipment, instructions, img_url, external_id, source, is_global)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'wger', 1)`
  );

  let count = 0;
  let offset = 0;
  const LIMIT = 100;

  while (true) {
    try {
      const url = `https://wger.de/api/v2/exerciseinfo/?format=json&language=2&limit=${LIMIT}&offset=${offset}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) { logger.warn(`[wger] API ${res.status}`); break; }

      const data = await res.json();
      const results = data.results || [];

      for (const ex of results) {
        const en = ex.translations?.find(t => t.language === 2);
        if (!en?.name) continue;

        const name = en.name.trim();
        const category = CATEGORY_MAP[ex.category?.id] || 'other';
        const primaryMuscles = (ex.muscles || []).map(m => MUSCLE_MAP[m.id] || m.name_en || `Muscle ${m.id}`);
        const secondaryMuscles = (ex.muscles_secondary || []).map(m => MUSCLE_MAP[m.id] || m.name_en || `Muscle ${m.id}`);
        const equipment = (ex.equipment || []).map(e => EQUIPMENT_MAP[e.id] || 'Other');
        const instructions = en.description?.replace(/<[^>]+>/g, '') || '';
        const img = ex.images?.find(i => i.is_main)?.image || ex.images?.[0]?.image || null;

        insert.run(
          name, category,
          JSON.stringify(primaryMuscles),
          JSON.stringify(secondaryMuscles),
          JSON.stringify([...new Set(equipment)]),
          instructions || null,
          img,
          ex.id
        );
        count++;
      }
      if (!data.next) break;
      offset += LIMIT;
    } catch(e) {
      logger.error(`[wger] ${e.message}`);
      break;
    }
  }
  return count;
}
