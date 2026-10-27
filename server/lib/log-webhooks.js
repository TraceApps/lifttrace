/**
 * The body_stat.logged and pr.set webhooks (issue #79), sent the same way
 * from every place that saves them: the app's own routes (PUT
 * /api/body-stats/:date, PUT /api/workout/:date) and the shared cores the
 * MCP tools and the public REST API use (logBodyStatCore, logSetCore).
 * Before #134's follow-up only the app's routes sent them, so a weight or a
 * record logged through MCP or /api/v1 reached no webhook.
 *
 * Each save calls one of these once, and every call is wrapped so a webhook
 * failure can never block or fail the save.
 */
import { dispatchWebhookEvent, WEBHOOKS_ENABLED } from './webhooks.js';
import { getRecordsCore, hasQualifyingSet } from './mcp/tools/get-records.js';

/**
 * A save that is part of the Android app's Upload (src/lib/migrate.js): a
 * phone used without a server sending its history to the server it just
 * connected to, one save per workout, body-stat day and cardio session,
 * through the same routes a connected phone logs through. That is history
 * arriving, not something logged now, so it sends no webhooks; before
 * #134's follow-up a year of history was hundreds of them.
 *
 * The app marks those saves `history_upload: true` (servers before this
 * one ignore the field). The 1.4.0 app doesn't, but gives every workout
 * and cardio session it uploads a key of its own, `upload:<kind>:<hash>`,
 * which nothing else sends (offline creates use a random key,
 * `device-workout:`, `adopt:`, `legacy:` or `web-workout`). Its body
 * stats carry no key and still send.
 */
export function isHistoryUpload(req) {
  const body = req?.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  if (body.history_upload === true) return true;
  return typeof body.client_key === 'string' && body.client_key.startsWith('upload:');
}

/** body_stat.logged for a save of `date`, carrying the day's merged stats. */
export function sendBodyStatLogged(userId, date, stats) {
  try { dispatchWebhookEvent(userId, 'body_stat.logged', { date, stats }); }
  catch { /* never let a webhook failure block the save */ }
}

/**
 * The records before a save, for sendNewRecords to compare against after
 * it. Taken BEFORE the save so the "before" state really predates it. Null
 * (nothing to compare, nothing sent) when the sets being saved can't move a
 * record (hasQualifyingSet: only notes, warm-ups, unfinished or unweighted
 * sets), when webhooks are off, or without an account to own a webhook, so
 * those saves never pay for two full-history scans.
 */
export function recordsBeforeSave(userId, exercises) {
  if (!WEBHOOKS_ENABLED || userId == null) return null;
  if (!Array.isArray(exercises) || !hasQualifyingSet(exercises)) return null;
  try { return getRecordsCore(userId).records; } catch { return null; }
}

/**
 * pr.set once per exercise whose max weight, estimated 1-rep max or longest
 * hold (issue #89) improved since `before`, using the record definition
 * get-records.js gives GET /api/v1/records and the Statistics page, so all
 * agree on what "a record" means. A save that changed no record (a repeat
 * of the same save, a lighter set) sends nothing.
 */
export function sendNewRecords(userId, date, before) {
  if (!before) return;
  try {
    const recordsAfter = getRecordsCore(userId).records;
    const beforeByExercise = new Map(before.map(r => [r.exercise_id, r]));
    for (const after of recordsAfter) {
      const prev = beforeByExercise.get(after.exercise_id);
      const improvedWeight = after.maxWeight > (prev?.maxWeight ?? 0);
      const improvedE1rm = after.e1rm > (prev?.e1rm ?? 0);
      const improvedDuration = (after.maxDuration || 0) > (prev?.maxDuration ?? 0);
      if (improvedWeight || improvedE1rm || improvedDuration) {
        dispatchWebhookEvent(userId, 'pr.set', {
          exercise_id: after.exercise_id,
          exercise_name: after.name,
          date,
          new_max_weight: after.maxWeight,
          new_max_reps: after.maxReps,
          new_e1rm: after.e1rm,
          previous_max_weight: prev?.maxWeight ?? 0,
          previous_e1rm: prev?.e1rm ?? 0,
          new_max_duration_sec: after.maxDuration || 0,
          previous_max_duration_sec: prev?.maxDuration ?? 0,
        });
      }
    }
  } catch { /* never let a webhook failure block the save */ }
}
