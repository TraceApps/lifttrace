/**
 * Equipment normalization — collapses the many raw equipment strings that
 * different sources (wger / free-db / exercisedb / exercisedb-oss / custom
 * XLSX imports) use into a small set of user-facing buckets so the filter
 * row stays readable.
 *
 *   Barbell    — barbell, EZ-bar, SZ-bar, trap bar, Smith machine, olympic
 *   Dumbbell   — dumbbell / DB
 *   Cable      — cable, pulley, tower, crossover
 *   Machine    — leverage, hammer strength, lever, sled, selectorized,
 *                plate-loaded, generic "machine", "weighted"
 *   Bodyweight — body weight / body only / none / assisted / calisthenics
 *   Other      — everything else (kettlebell, bands, medicine ball, rope,
 *                TRX, foam roller, chains, sandbag, stability ball, etc.)
 *
 * The bucket list doubles as the canonical sort order for filter chips.
 */

export const EQUIPMENT_BUCKETS = [
  'Barbell',
  'Bodyweight',
  'Dumbbell',
  'Cable',
  'Machine',
  'Other',
];

const EQUIPMENT_PATTERNS = [
  { bucket: 'Barbell',    re: /(^|\W)(barbell|e-?z.?(curl.?)?bar|sz.?bar|smith|trap.?bar|olympic|deadlift.?bar|squat.?bar|hex.?bar)(\W|$)/i },
  { bucket: 'Dumbbell',   re: /(^|\W)(dumbbell|db)(\W|$)/i },
  { bucket: 'Cable',      re: /(^|\W)(cable|pulley|tower|crossover)(\W|$)/i },
  { bucket: 'Machine',    re: /(^|\W)(machine|leverage|hammer\s*strength|lever|sled|selectorized|plate.?loaded|weighted)(\W|$)/i },
  { bucket: 'Bodyweight', re: /(^|\W)(body\s?weight|body\s?only|bodyweight|none|assisted|calisthenics)(\W|$)/i },
];

/** Map a raw equipment string to one of the 6 buckets. Empty input → empty. */
export function normalizeEquipment(name) {
  const raw = String(name || '').trim();
  if (!raw) return '';
  for (const { bucket, re } of EQUIPMENT_PATTERNS) {
    if (re.test(raw)) return bucket;
  }
  return 'Other';
}

/** Stable sort comparator for bucket names — follows EQUIPMENT_BUCKETS order. */
export function sortByBucket(a, b) {
  const ai = EQUIPMENT_BUCKETS.indexOf(a);
  const bi = EQUIPMENT_BUCKETS.indexOf(b);
  if (ai === -1 && bi === -1) return a.localeCompare(b);
  if (ai === -1) return 1;
  if (bi === -1) return -1;
  return ai - bi;
}
