import db from '../db.js';
import { linkBase } from './public-url.js';
import { logger } from '../logger.js';
import { pushNotify } from './push-notify.js';
import { sendWeeklySummary, isEmailConfigured } from '../email.js';
import { checkMissedPrescriptions } from './coach-activity.js';
import { buildWeeklySummary, summaryLine } from './weekly-summary.js';
import { isBackupDue } from './backup-schedule.js';

/**
 * Server-side scheduler — runs every 15 minutes.
 * Checks each user's notification settings and fires push notifications
 * for workout reminders, streak alerts, and weekly summaries.
 */

const TICK_MS = 15 * 60 * 1000;
const _recentlyRan = {};

function _ranRecently(userId, task, windowMs) {
  const key = `${userId}:${task}`;
  const last = _recentlyRan[key];
  if (last && Date.now() - last < windowMs) return true;
  _recentlyRan[key] = Date.now();
  return false;
}

function _getUserSetting(userId, key, defaultVal) {
  const row = userId
    ? db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?').get(userId, key)
    : null;
  if (!row) return defaultVal;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

function _localHour(timezone) {
  try {
    // hourCycle h23, not hour12: false: with that, Node 20's ICU writes the
    // hour after midnight as "24", and nothing set for 00:00 to 00:59 fired.
    const str = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || 'UTC',
      hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
    }).format(new Date());
    const [h, m] = str.split(':').map(Number);
    return { hour: h % 24, minute: m };
  } catch {
    const now = new Date();
    return { hour: now.getHours(), minute: now.getMinutes() };
  }
}

/**
 * Whether a time is due now, and for which day: 0 for today, -1 for
 * yesterday (a 23:55 reminder checked at 00:05 belongs to the day that just
 * ended), null when not due. Due up to windowMin late, across midnight too;
 * up to windowMin early only on the same day, so a reminder for just after
 * midnight never goes out the evening before.
 */
export function _dueDay(localTime, targetStr, windowMin = 15) {
  const [th, tm] = (targetStr || '00:00').split(':').map(Number);
  const targetMins = th * 60 + tm;
  const currentMins = (localTime.hour % 24) * 60 + localTime.minute;
  const late = ((currentMins - targetMins) % 1440 + 1440) % 1440;
  if (late <= windowMin) return currentMins < targetMins ? -1 : 0;
  const early = targetMins - currentMins;
  return early >= 0 && early <= windowMin ? 0 : null;
}

export function _withinWindow(localTime, targetStr, windowMin = 15) {
  return _dueDay(localTime, targetStr, windowMin) !== null;
}

/** A YYYY-MM-DD moved by n calendar days. */
function _shiftDay(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function _todayStr(timezone) {
  try {
    return new Intl.DateTimeFormat('sv-SE', { timeZone: timezone || 'UTC' }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

async function _tick() {
  try {
    const users = db.prepare('SELECT * FROM users').all();
    if (users.length === 0) {
      // Single-user mode — run with userId = null
      await _processUser(null);
    } else {
      for (const user of users) {
        await _processUser(user.id);
      }
    }

    // Housekeeping — remove invite tokens that are past their expiry or
    // already used. GET /api/auth/invites filters them out of the admin
    // list, but rows sit in the table indefinitely otherwise. Cheap to
    // clean up here every 15 minutes.
    try {
      const r = db.prepare(`DELETE FROM invite_tokens WHERE expires_at <= datetime('now') OR used = 1`).run();
      if (r.changes > 0) logger.debug(`[scheduler] purged ${r.changes} expired/used invite tokens`);
    } catch (e) {
      logger.debug(`[scheduler] invite cleanup error: ${e.message}`);
    }

    // Coach activity — flag dated prescriptions whose date has passed without
    // a matching completed workout. Idempotent (UNIQUE constraint), so
    // running every tick is cheap; once a prescription is flagged it stays
    // flagged. Trainers with notifMemberMissed=true get a push.
    try { checkMissedPrescriptions(); }
    catch (e) { logger.debug(`[scheduler] missed-prescription check error: ${e.message}`); }

    // Scheduled full backup (admin-global, TraceApps parity with NT + CT).
    try { await _checkBackupSchedule(); }
    catch (e) { logger.debug(`[scheduler] backup check error: ${e.message}`); }
  } catch(e) {
    logger.error(`[scheduler] tick error: ${e.message}`);
  }
}

async function _checkBackupSchedule() {
  const { getScheduleConfig, runScheduledBackup } = await import('../routes/full-backup.js');
  const cfg = getScheduleConfig();
  if (cfg.schedule === 'off') return;
  // The time is on the clock of whoever set it, in the zone saved with it (TraceApps/notetrace#44).
  if (!isBackupDue(cfg)) return;
  logger.info(`[backup] auto-backup due (schedule=${cfg.schedule}, time=${cfg.time} ${cfg.runsIn}, retention=${cfg.retention}, last=${cfg.lastAutoRun || 'never'})`);
  try { await runScheduledBackup(); } catch {}
}

async function _processUser(userId) {
  const tz = _getUserSetting(userId, 'timezone', null);
  const localTime = _localHour(tz);
  const today = _todayStr(tz);

  // ── Workout reminder ──────────────────────────────────────────────────
  const workoutReminder = _getUserSetting(userId, 'notifWorkoutReminder', false);
  if (workoutReminder) {
    const time = _getUserSetting(userId, 'notifWorkoutTime', '07:00');
    const due = _dueDay(localTime, time);
    if (due !== null && !_ranRecently(userId, 'workoutReminder', 3600000)) {
      // Check if a workout is already logged on the reminder's day
      const day = _shiftDay(today, due);
      const logged = userId
        ? db.prepare('SELECT 1 FROM workout_log WHERE user_id = ? AND date = ? AND deleted_at IS NULL').get(userId, day)
        : db.prepare('SELECT 1 FROM workout_log WHERE date = ? AND deleted_at IS NULL').get(day);
      if (!logged) {
        // Get active program template name
        let templateName = '';
        const activeRow = userId
          ? db.prepare('SELECT program_id FROM program_assignments WHERE assigned_to = ? AND active = 1').get(userId)
          : db.prepare("SELECT value FROM app_config WHERE key = 'active_program'").get();
        if (activeRow) {
          const progId = activeRow.program_id || activeRow.value;
          const template = db.prepare('SELECT name FROM workout_templates WHERE program_id = ? ORDER BY order_index LIMIT 1').get(progId);
          if (template) templateName = template.name;
        }
        const msg = templateName
          ? `Time to train! Today's workout: ${templateName}`
          : "Time to train! Open LiftTrace and get after it.";
        await pushNotify(userId, '🏋️ Workout Reminder', msg, 4);
      }
    }
  }

  // ── Rest day reminder ─────────────────────────────────────────────────
  const restDayReminder = _getUserSetting(userId, 'notifRestDay', false);
  if (restDayReminder) {
    // Fire at 10 AM local time on days right after a workout
    if (_withinWindow(localTime, '10:00', 30) && !_ranRecently(userId, 'restDay', 22 * 3600000)) {
      const yesterday = new Date(Date.now() - 24 * 3600000).toISOString().slice(0, 10);
      const loggedYesterday = userId
        ? db.prepare('SELECT 1 FROM workout_log WHERE user_id = ? AND date = ? AND deleted_at IS NULL').get(userId, yesterday)
        : db.prepare('SELECT 1 FROM workout_log WHERE date = ? AND deleted_at IS NULL').get(yesterday);
      const loggedToday = userId
        ? db.prepare('SELECT 1 FROM workout_log WHERE user_id = ? AND date = ? AND deleted_at IS NULL').get(userId, today)
        : db.prepare('SELECT 1 FROM workout_log WHERE date = ? AND deleted_at IS NULL').get(today);
      if (loggedYesterday && !loggedToday) {
        await pushNotify(userId, '🧘 Rest Day', 'Time to recover — hydrate, stretch, and refuel. See you tomorrow!', 3);
      }
    }
  }

  // ── Streak alert ──────────────────────────────────────────────────────
  const streakAlert = _getUserSetting(userId, 'notifStreakAlert', false);
  if (streakAlert) {
    const time = _getUserSetting(userId, 'notifStreakTime', '20:00');
    const due = _dueDay(localTime, time);
    if (due !== null && !_ranRecently(userId, 'streakAlert', 3600000)) {
      const day = _shiftDay(today, due); // the alert's day (yesterday, just after midnight)
      const logged = userId
        ? db.prepare('SELECT 1 FROM workout_log WHERE user_id = ? AND date = ? AND deleted_at IS NULL').get(userId, day)
        : db.prepare('SELECT 1 FROM workout_log WHERE date = ? AND deleted_at IS NULL').get(day);
      if (!logged) {
        // Calculate current streak
        // Calendar days back from the same today the check above used,
        // stepped in UTC on the bare date (#101).
        let streak = 0;
        let ds = _shiftDay(day, -1); // start from the day before
        while (true) {
          const row = userId
            ? db.prepare('SELECT 1 FROM workout_log WHERE user_id = ? AND date = ? AND deleted_at IS NULL').get(userId, ds)
            : db.prepare('SELECT 1 FROM workout_log WHERE date = ? AND deleted_at IS NULL').get(ds);
          if (!row) break;
          streak++;
          ds = _shiftDay(ds, -1);
        }
        if (streak > 0) {
          await pushNotify(userId, '🔥 Streak at Risk!', `Your ${streak}-day streak is on the line — log a workout today to keep it alive!`, 7);
        }
      }
    }
  }

  // Weekly summary (issue #98): sessions against the weekly goal, sets,
  // volume with its unit, time trained, PRs and sets per muscle group, each
  // compared with the user's average week over the month before.
  const weeklySummary = _getUserSetting(userId, 'notifWeeklySummary', false);
  if (weeklySummary) {
    const targetDay = Number(_getUserSetting(userId, 'weeklySummaryDay', 0));
    const targetTime = _getUserSetting(userId, 'weeklySummaryTime', '09:00');
    // The user's own weekday, not the server's: the two disagree for part of
    // every day whenever they sit in different time zones.
    // Just after midnight a late match is yesterday's: it goes on yesterday's
    // weekday, so a 23:50 Monday summary never goes out early on Monday morning.
    const due = _dueDay(localTime, targetTime, 30);
    if (due !== null && (_localWeekday(tz) + 7 + due) % 7 === targetDay && !_ranRecently(userId, 'weeklySummary', 6 * 24 * 3600000)) {
      const workouts = userId
        ? db.prepare('SELECT date, exercises, duration_min FROM workout_log WHERE user_id = ? AND deleted_at IS NULL').all(userId)
        : db.prepare('SELECT date, exercises, duration_min FROM workout_log WHERE deleted_at IS NULL').all();
      const summary = buildWeeklySummary({
        workouts,
        library: _exerciseLibrary(),
        today: _shiftDay(today, due),
        goal: _getUserSetting(userId, 'weeklyWorkoutGoal', 4),
      });
      const unit = _getUserSetting(userId, 'weightUnit', 'lbs') === 'kg' ? 'kg' : 'lbs';
      const locale = String(_getUserSetting(userId, 'language', 'en') || 'en');

      await pushNotify(userId, '📊 Weekly Summary', summaryLine(summary, { unit, locale }), 4);

      if (isEmailConfigured()) {
        const user = userId ? db.prepare('SELECT * FROM users WHERE id = ?').get(userId) : null;
        if (user?.email) {
          try {
            const origin = linkBase(null) || 'http://localhost:3002';
            await sendWeeklySummary(user.email, user.nickname || user.full_name || user.username, summary, origin, { unit, locale });
          } catch(e) {
            logger.warn(`[scheduler] weekly email failed: ${e.message}`);
          }
        }
      }
    }
  }
}

function _localWeekday(timezone) {
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: timezone || 'UTC', weekday: 'short' }).format(new Date());
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(name);
  } catch {
    return new Date().getDay();
  }
}

// exercise_id -> { muscles, category, load_type }. Includes cleared library
// rows, as Muscle Balance does, so sets logged against them still resolve.
function _exerciseLibrary() {
  const map = new Map();
  for (const ex of db.prepare('SELECT id, primary_muscles, category, load_type FROM exercises').all()) {
    let muscles = [];
    try { muscles = JSON.parse(ex.primary_muscles || '[]'); } catch {}
    map.set(ex.id, { muscles, category: ex.category || 'other', load_type: ex.load_type || null });
  }
  return map;
}

export function startScheduler() {
  logger.info('[scheduler] Starting 15-minute tick loop');
  // Run first tick after 30s (let server finish startup)
  setTimeout(() => {
    _tick();
    setInterval(_tick, TICK_MS);
  }, 30000);
}
