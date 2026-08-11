import db from '../db.js';
import { logger } from '../logger.js';
import { seedFromWger }       from './wger.js';
import { seedFromFreeDb }     from './free-db.js';
import { seedFromExerciseDb } from './exercisedb.js';
import { seedFromExerciseDbOss } from './exercisedb-oss.js';

/**
 * Catalog source registry. Each source is identified by `id` (also stored in
 * the exercises.source column) and exposes a seed function. Sources can be
 * imported, removed, and listed independently.
 */
export const SOURCES = [
  {
    id: 'wger',
    name: 'wger',
    description: 'Free open-source exercise database (~600 exercises, sparse images, no GIFs)',
    requiresKey: false,
    seed: seedFromWger,
  },
  {
    id: 'free-db',
    name: 'Free Exercise DB',
    description: 'Public-domain catalog (~870 exercises) with start/end position images for every entry',
    requiresKey: false,
    seed: seedFromFreeDb,
  },
  {
    id: 'exercisedb',
    name: 'ExerciseDB (RapidAPI)',
    description: '~1,300 exercises with animated GIFs. Requires a RapidAPI key (paid). Note: media URLs rotate weekly \u2014 re-import every Monday to refresh cached links.',
    requiresKey: true,
    seed: seedFromExerciseDb,
  },
  {
    id: 'exercisedb-oss',
    name: 'ExerciseDB (open-source)',
    description: '~1,500 exercises with animated GIFs. AGPL-3.0. Free, no key \u2014 uses oss.exercisedb.dev (community-hosted, no SLA).',
    requiresKey: false,
    seed: seedFromExerciseDbOss,
  },
];

export function getSource(id) {
  return SOURCES.find(s => s.id === id);
}

/** Status: per-source counts in the database */
export function listSourceStatus() {
  const counts = db.prepare(
    // Live rows only — cleared catalogs are soft-deleted (#49) but shouldn't
    // count against the "already have exercises from this source" tally.
    `SELECT source, COUNT(*) as c FROM exercises WHERE deleted_at IS NULL GROUP BY source`
  ).all();
  const map = Object.fromEntries(counts.map(r => [r.source, r.c]));
  return SOURCES.map(s => ({
    id: s.id,
    name: s.name,
    description: s.description,
    requiresKey: s.requiresKey,
    count: map[s.id] || 0,
  }));
}

/** Run a single source's seeder. opts can carry { apiKey } */
export async function importSource(id, opts = {}) {
  const src = getSource(id);
  if (!src) throw new Error(`Unknown source: ${id}`);
  if (src.requiresKey && !opts.apiKey) throw new Error(`Source "${id}" requires an API key`);
  logger.info(`[exercise-sources] Importing from ${id}…`);
  const count = await src.seed(opts);
  logger.info(`[exercise-sources] ${id}: imported ${count}`);
  return count;
}

/** Soft-delete every globally-seeded exercise tagged with this source.
 *  Hard-delete would orphan `exercise_id` references sitting in
 *  workout_log / workout_templates / coach_prescriptions JSON blobs;
 *  Muscle Balance then buckets every affected set as `other` and per-
 *  exercise progress returns empty (issue #49). Soft-delete keeps the
 *  row (and its `id`) intact; the pre-checks in the seeders resurrect
 *  it on the next matching import instead of inserting a new row.
 *  Reads on the exercises table filter by `deleted_at IS NULL` so
 *  soft-deleted rows stay out of pickers, stats lookups, and exports. */
export function clearSource(id) {
  const result = db.prepare(
    `UPDATE exercises
       SET deleted_at = datetime('now'), updated_at = datetime('now')
     WHERE source = ? AND is_global = 1 AND deleted_at IS NULL`
  ).run(id);
  return result.changes;
}

/** Auto-seed on first boot. Reads EXERCISE_SOURCES env var.
 *
 *  Default is empty ('') — new installs land with an empty library and
 *  the first-run wizard prompts the user to pick what to import (with
 *  license terms surfaced). Self-hosters can still force auto-seed via
 *  EXERCISE_SOURCES='wger,free-db' in their compose file. */
export async function autoSeed() {
  // Live rows only — a fresh install that has soft-deleted rows from a
  // previous clear should still see a bootstrap seed happen (#49).
  const total = db.prepare('SELECT COUNT(*) as c FROM exercises WHERE deleted_at IS NULL').get().c;
  if (total >= 10) return;

  const raw = process.env.EXERCISE_SOURCES || '';
  const enabled = raw.split(',').map(s => s.trim()).filter(Boolean);
  if (enabled.length === 0) {
    logger.info('[exercise-sources] Library is empty and no auto-seed sources configured. User will be prompted on first run.');
    return;
  }

  logger.info(`[exercise-sources] Library is empty — auto-seeding: ${enabled.join(', ')}`);
  for (const id of enabled) {
    try {
      await importSource(id);
    } catch(e) {
      logger.warn(`[exercise-sources] Auto-seed of ${id} failed: ${e.message}`);
    }
  }
}
