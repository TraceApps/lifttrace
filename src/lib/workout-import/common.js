/**
 * Shared helpers for third-party workout CSV imports (Strong, Hevy, ...).
 *
 * Canonical workout shape returned by every app adapter:
 *   {
 *     date: 'YYYY-MM-DD',
 *     name: string,
 *     notes: string,
 *     duration_min: number|null,
 *     exercises: [
 *       {
 *         sourceName: string,     // the name exactly as the source CSV had it
 *         exercise_id: number|null, // populated by matchCanonical() after parse
 *         exercise_name: string,    // populated by matchCanonical() — matched or sourceName
 *         superset_id: number|null, // populated if the source exports supersets (Hevy)
 *         superset_size: number,
 *         sets: [ { reps, weight, completed: true, notes, rpe } ]
 *       }
 *     ]
 *   }
 */

/** Quoted-safe CSV line splitter. Handles "a,b"" c",d style escapes. */
export function splitCsvLine(line, delim) {
  const out = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuote) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQuote = false;
      else cur += c;
    } else {
      if (c === '"') inQuote = true;
      else if (c === delim) { out.push(cur); cur = ''; }
      else cur += c;
    }
  }
  out.push(cur);
  return out.map(s => s.trim());
}

/** Parse a CSV with a header row into array of keyed objects. */
export function parseCsv(text, delim) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').filter(l => l.trim());
  if (lines.length === 0) return [];
  const header = splitCsvLine(lines[0], delim).map(h => h.toLowerCase());
  return lines.slice(1).map(line => {
    const cols = splitCsvLine(line, delim);
    const row = {};
    for (let i = 0; i < header.length; i++) row[header[i]] = cols[i] ?? '';
    return row;
  });
}

const KG_TO_LBS = 2.20462;

/** Convert a raw weight value to the user's preferred unit. */
export function convertWeight(value, fromUnit, toUnit) {
  const n = parseFloat(value);
  if (!Number.isFinite(n) || n === 0) return 0;
  const from = String(fromUnit || '').toLowerCase();
  const to = String(toUnit || '').toLowerCase();
  if (from === to) return Math.round(n * 100) / 100;
  if (from === 'kg' && to === 'lbs') return Math.round(n * KG_TO_LBS * 100) / 100;
  if (from === 'lbs' && to === 'kg') return Math.round((n / KG_TO_LBS) * 100) / 100;
  return Math.round(n * 100) / 100;
}

/** Strip common equipment suffixes the other apps add, so our library matcher
 *  doesn't miss obvious cases:
 *    "Bench Press (Barbell)"     -> "Bench Press"
 *    "Lat Pulldown (Cable)"      -> "Lat Pulldown"
 *    "Seated Row - Machine"      -> "Seated Row"
 */
export function cleanExerciseName(raw) {
  return String(raw || '')
    .replace(/\s*\((?:barbell|bb|dumbbell|db|cable|machine|bodyweight|bw|smith\s*machine|kettlebell|kb|band)\)\s*/gi, ' ')
    .replace(/\s*[-–—]\s*(?:barbell|bb|dumbbell|db|cable|machine|bodyweight|smith|kettlebell|band)\b.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Fuzzy match a source name against the user's library. Mirrors the
 *  Smart-Log matcher's priority (exact -> starts-with -> substring ->
 *  token-overlap). Returns the best library match or null. */
export function matchExercise(sourceName, library) {
  if (!sourceName) return null;
  const cleaned = cleanExerciseName(sourceName).toLowerCase();
  if (!cleaned) return null;

  // 1. Exact (against both cleaned + raw library names)
  let hit = library.find(e => e.name.toLowerCase() === cleaned);
  if (hit) return hit;

  // 2. Starts-with
  hit = library.find(e => e.name.toLowerCase().startsWith(cleaned));
  if (hit) return hit;

  // 3. Substring either way
  hit = library.find(e => {
    const lib = e.name.toLowerCase();
    return lib.includes(cleaned) || cleaned.includes(lib);
  });
  if (hit) return hit;

  // 4. Token overlap (≥ half the tokens + ≥ 2 tokens match)
  const tokens = new Set(cleaned.split(/\s+/).filter(t => t.length > 1));
  if (tokens.size === 0) return null;
  let best = { match: null, overlap: 0 };
  for (const e of library) {
    const libTokens = new Set(e.name.toLowerCase().split(/\s+/).filter(t => t.length > 1));
    let overlap = 0;
    for (const t of tokens) if (libTokens.has(t)) overlap++;
    const threshold = Math.max(2, Math.ceil(tokens.size / 2));
    if (overlap >= threshold && overlap > best.overlap) best = { match: e, overlap };
  }
  return best.match;
}
