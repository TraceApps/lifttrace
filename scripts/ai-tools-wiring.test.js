/**
 * Keeps Trace's tool surface honest.
 *
 * Trace is a fourth caller alongside the app routes, the MCP tools and the
 * REST API, but it keeps its own tool list rather than importing the xCore
 * functions, so a feature can ship to the other three and silently miss it.
 * That is exactly what happened with progress photos. These guard the two
 * ways that drift shows up: a tool defined but never dispatched, and a tool
 * dispatched but never named in the system prompt (weaker models rely on
 * the prompt enumeration, not just the schema).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const aiTools = read('../src/lib/aiTools.js');
const trace = read('../src/components/ai/Trace.svelte');

const defined = [...aiTools.matchAll(/^\s{4}name: '(\w+)',$/gm)].map((m) => m[1]);

test('every defined tool is dispatched by runTool', () => {
  assert.ok(defined.length > 10, `expected a real tool list, found ${defined.length}`);
  for (const name of defined) {
    assert.match(aiTools, new RegExp(`case '${name}':`), `${name} is defined but never dispatched`);
  }
});

test('every defined tool is named in the system prompt', () => {
  // The prompt lists tools explicitly because mini-class models skip
  // schema-only tools; a tool missing here is effectively invisible.
  const prompt = trace.slice(trace.indexOf('You are ${botName}'), trace.indexOf('const apiMessages'));
  for (const name of defined) {
    assert.ok(prompt.includes(name), `${name} is not listed in the system prompt`);
  }
});

test('Trace can read progress photo metadata', () => {
  assert.ok(defined.includes('get_progress_photos'));
  assert.match(aiTools, /\/api\/body-stats\/photos\?start=/);
});

test('Trace is never handed progress photo image content', () => {
  // The bytes sit behind an ownership-checked route on purpose. Sending a
  // user's body photos to whichever third-party model is configured is not
  // something a convenience tool should do as a side effect; attaching an
  // image to a message stays an explicit, per-message act by the user.
  const fn = aiTools.slice(aiTools.indexOf('async function _getProgressPhotos'));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 3);
  assert.doesNotMatch(body, /\/file/, 'must not fetch the image bytes');
  assert.doesNotMatch(body, /dataUrl|base64|blob/i, 'must not embed image content');
  assert.match(body, /note:/, 'should tell the model it cannot see the images');
});

/**
 * Coverage map: every table holding user training data should be reachable
 * by Trace, or be listed here with a reason.
 *
 * This is the check that would have caught cardio, which shipped its own
 * table and diary card and then sat invisible to the coach for several
 * releases. A table added without either a tool or an entry below fails
 * this test, which forces the question to be asked rather than missed.
 */
const EXEMPT = {
  ai_chat_history:       "Trace's own transcript, not something to query",
  api_tokens:            'credentials, never user content',
  app_config:            'instance settings, admin surface',
  invite_tokens:         'auth plumbing',
  oauth_state:           'auth plumbing',
  oidc_providers:        'auth plumbing',
  password_reset_tokens: 'auth plumbing',
  user_oidc_links:       'auth plumbing',
  users:                 'account records; the profile block covers what Trace needs',
  user_settings:         'surfaced through buildUserProfile in the system prompt',
  webhooks:              'integration config, not training data',
  workout_tombstones:    'sync bookkeeping',
  coach_activity:        'trainer audit trail, not the athlete view',
  program_assignments:   'reached through get_active_program',
  coach_feedback:        'returned inside get_workout detail',
  body_stat_media:       'covered by get_progress_photos',
  set_media:             'video Trace cannot watch; the coach note on a clip is returned inside get_workout detail',
};

// table -> a tool whose implementation must mention this API path
const COVERED = {
  body_stats_log:      /\/api\/body-stats/,
  cardio_log:          /\/api\/cardio/,
  exercises:           /\/api\/exercises/,
  exercise_muscle_overrides: /\/api\/exercises/,
  programs:            /\/api\/programs/,
  workout_log:         /\/api\/workout/,
  workout_templates:   /\/api\/(templates|workout)/,
  coach_prescriptions: /\/api\/(trainer|coach|prescription)/,
};

test('every user-data table is reachable by Trace or explicitly exempt', () => {
  const db = read('../server/db.js');
  const tables = [...db.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
  const unaccounted = tables.filter((t) => !(t in EXEMPT) && !(t in COVERED));
  assert.deepEqual(unaccounted, [],
    `these tables have no Trace tool and no exemption: ${unaccounted.join(', ')}. `
    + 'Add a tool, or add an entry to EXEMPT saying why not.');
});

test('each covered table has a tool that actually reaches its API', () => {
  for (const [table, pathRe] of Object.entries(COVERED)) {
    assert.match(aiTools, pathRe, `no Trace tool appears to read ${table}`);
  }
});

test('Trace can read and log cardio', () => {
  // Cardio is its own table, so get_workouts and get_stats_overview say
  // nothing about it. Without these, Trace tells someone training five days
  // a week that they have done nothing since Tuesday.
  assert.ok(defined.includes('get_cardio'));
  assert.ok(defined.includes('log_cardio'));
  const prompt = trace.slice(trace.indexOf('You are ${botName}'), trace.indexOf('const apiMessages'));
  assert.match(prompt, /does NOT appear in get_workouts/,
    'the prompt must say cardio is absent from the lifting tools, or the model will not look');
});
