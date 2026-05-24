// Smart Log for workouts — natural-language → structured exercise entries.
//
// Flow:
//   1. parseInput(text) — AI parses the user's prose into structured items.
//   2. matchExercises(items) — resolves each item's name against the library.
//   3. saveExercises(matchedItems, date, append) — writes to workout_log.
//
// Handles uniform sets ("3x5 @ 225"), per-set variation ("225x5, 245x5, 265x5"),
// bodyweight ("BW×8"), bodyweight+added ("BW+25 3x8"), AMRAP, RPE tags, and
// supersets/circuits ("A1: bench, A2: rows, 3 rounds").

import { callAI, callAIProxy } from './aiChat.js';
import { aiEnabled, aiProvider, aiApiKey, aiModel, aiBaseUrl } from '../stores/settings.js';
import { AI_DEFAULT_MODELS } from './aiChat.js';
import { get } from 'svelte/store';

const PARSE_SYSTEM_PROMPT = `You parse weightlifting session descriptions into structured JSON.

Output ONLY valid JSON matching this schema:
{
  "exercises": [
    {
      "name": "exercise name exactly as user said it",
      "sets": [ { "reps": N, "weight": N, "rpe": N|null, "amrap": true|false, "bodyweight": true|false } ],
      "superset_group": "A"|"B"|null,   // fill only when user groups exercises (A1/A2/B1/B2 etc.)
      "notes": string|null
    }
  ]
}

Rules:
- "3x5 @ 225" means 3 identical sets of {reps:5, weight:225}. Expand it.
- "225x5, 245x5, 265x5" means 3 different sets — preserve each.
- "BW" or "bodyweight" → set bodyweight:true and weight:0 (unless user said "BW+25" → bodyweight:true, weight:25).
- "@8" or "RPE 8" → rpe:8.
- "AMRAP" or "as many as possible" → amrap:true and reps:0.
- "A1: bench, A2: row, 3 rounds" — emit bench AND row with 3 sets each, superset_group:"A".
- Assume pounds unless user says "kg". Do NOT convert units.
- If user gives a range like "3x8-10", pick the midpoint (9).
- Return empty exercises array if you cannot parse anything meaningful.
- NEVER include text outside the JSON. No markdown code fences.`;

export async function parseInput(text) {
  const t = (text || '').trim();
  if (!t) return { exercises: [] };

  const provider = get(aiProvider);
  const apiKey = get(aiApiKey);
  const model = get(aiModel) || AI_DEFAULT_MODELS[provider];
  const baseUrl = get(aiBaseUrl);
  const messages = [{ role: 'user', content: t }];

  let raw;
  // OpenAI-compatible endpoints (Ollama etc.) can run keyless — accept
  // either a real API key or an oai-compat config. Otherwise fall through
  // to the server-proxy path (env-locked install).
  const hasClientConfig = apiKey || (provider === 'oai-compat' && baseUrl);
  if (hasClientConfig) {
    raw = await callAI({ provider, apiKey, model, baseUrl: baseUrl || undefined, messages, systemPrompt: PARSE_SYSTEM_PROMPT });
  } else {
    raw = await callAIProxy({ messages, systemPrompt: PARSE_SYSTEM_PROMPT });
  }

  // Strip accidental markdown fences, then parse
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed.exercises)) return { exercises: [] };
    return parsed;
  } catch (e) {
    console.warn('[smart-log] JSON parse failed:', cleaned.slice(0, 200));
    throw new Error('Could not understand that. Try rephrasing — e.g. "bench 3x5 at 225, squat 5x5 at 315".');
  }
}

// Build a lowercased name → library candidates map. Cached per session.
let _libraryCache = null;
let _libraryCacheAt = 0;
async function _getLibrary() {
  const now = Date.now();
  if (_libraryCache && now - _libraryCacheAt < 5 * 60_000) return _libraryCache;
  const res = await fetch('/api/exercises', { credentials: 'include' });
  if (!res.ok) throw new Error('Failed to load exercise library');
  _libraryCache = await res.json();
  _libraryCacheAt = now;
  return _libraryCache;
}

// Simple fuzzy score: higher = better. Exact match wins; substring match beats
// token-overlap. Capped so perfect-match ≈ 100.
function _scoreMatch(query, libName) {
  const q = query.toLowerCase().trim();
  const n = libName.toLowerCase().trim();
  if (!q || !n) return 0;
  if (q === n) return 100;
  if (n.startsWith(q)) return 85;
  if (n.includes(q)) return 70;
  // Token overlap
  const qt = new Set(q.split(/\s+/));
  const nt = new Set(n.split(/\s+/));
  let hits = 0;
  for (const t of qt) if (nt.has(t)) hits++;
  if (hits === 0) return 0;
  return Math.round((hits / qt.size) * 50);
}

const ALIASES = {
  bp: 'bench press',
  ohp: 'overhead press',
  'military press': 'overhead press',
  'mp': 'overhead press',
  dl: 'deadlift',
  sq: 'squat',
  rdl: 'romanian deadlift',
  bb: 'barbell',
  db: 'dumbbell',
};

function _expandAlias(name) {
  const n = (name || '').toLowerCase().trim();
  return ALIASES[n] || n;
}

/**
 * Given parsed items from parseInput, resolve each exercise name to a library
 * entry (or leave as custom/unmatched).
 * Returns array of { raw, sets, superset_group, notes, candidates: [{exercise, score}], best }
 */
export async function matchExercises(parsed) {
  const library = await _getLibrary();
  const items = (parsed.exercises || []).map(ex => {
    const queries = [ex.name, _expandAlias(ex.name)].filter((v, i, a) => v && a.indexOf(v) === i);
    const scored = library.map(libEx => {
      let score = 0;
      for (const q of queries) score = Math.max(score, _scoreMatch(q, libEx.name));
      return { exercise: libEx, score };
    }).filter(c => c.score >= 30).sort((a, b) => b.score - a.score);
    const top = scored.slice(0, 5);
    return {
      raw: ex.name,
      sets: ex.sets || [],
      superset_group: ex.superset_group || null,
      notes: ex.notes || null,
      candidates: top,
      best: top[0]?.exercise || null,
    };
  });
  return items;
}

/**
 * Convert Smart-Log matched items to workout_log exercise rows, append (or
 * replace) into today's log, and save.
 *
 * @param {Array} matched items from matchExercises (may have user overrides
 *        set on .best or .customName)
 * @param {string} date   YYYY-MM-DD
 * @param {object} existingLog currently-loaded log ($todayLog); falsy = empty
 * @returns {Array} merged exercises array (for save)
 */
export function mergeIntoWorkout(matched, existingLog) {
  const existing = (existingLog?.exercises || []).slice();
  const nextSupersetId = (() => {
    let max = 0;
    for (const ex of existing) if (typeof ex.superset_id === 'number' && ex.superset_id > max) max = ex.superset_id;
    return max + 1;
  });

  // Resolve group-letter → allocated superset_id
  const groupIds = {};

  for (const m of matched) {
    const lib = m.best || null;
    const displayName = m.customName || lib?.name || m.raw;
    const row = {
      exercise_id: lib?.id || null,
      exercise_name: displayName,
      sets: (m.sets || []).map(s => ({
        reps: s.reps || 0,
        weight: s.weight || 0,
        completed: false,
        notes: s.notes || '',
        ...(s.amrap ? { amrap: true } : {}),
        ...(s.bodyweight ? { bodyweight: true } : {}),
        ...(s.rpe != null ? { rpe: s.rpe } : {}),
      })),
      target_sets: (m.sets || []).length || 1,
      target_reps: (m.sets?.[0]?.reps) || null,
      target_weight: (m.sets?.[0]?.weight) || null,
      notes: m.notes || '',
    };
    if (m.superset_group) {
      if (!groupIds[m.superset_group]) groupIds[m.superset_group] = nextSupersetId();
      row.superset_id = groupIds[m.superset_group];
    }
    existing.push(row);
  }

  // Fix superset_size for any newly added superset groups
  for (const gid of Object.values(groupIds)) {
    const members = existing.filter(e => e.superset_id === gid);
    for (const m of members) m.superset_size = members.length;
  }

  return existing;
}
