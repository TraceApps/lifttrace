import db from '../db.js';
import { logger } from '../logger.js';
import { pushNotify } from './push-notify.js';
import { sendWeeklySummary, isEmailConfigured } from '../email.js';
import { checkMissedPrescriptions } from './coach-activity.js';
import { setVolume } from './volume.js';

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
    const str = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || 'UTC',
      hour: 'numeric', minute: 'numeric', hour12: false,
    }).format(new Date());
    const [h, m] = str.split(':').map(Number);
    return { hour: h, minute: m };
  } catch {
    const now = new Date();
    return { hour: now.getHours(), minute: now.getMinutes() };
  }
}

function _withinWindow(localTime, targetStr, windowMin = 15) {
  const [th, tm] = (targetStr || '00:00').split(':').map(Number);
  const targetMins = th * 60 + tm;
  const currentMins = localTime.hour * 60 + localTime.minute;
  return Math.abs(currentMins - targetMins) <= windowMin;
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

const _BACKUP_INTERVAL_MS = {
  daily:   22 * 60 * 60 * 1000,
  weekly:  6.5 * 24 * 60 * 60 * 1000,
  monthly: 28 * 24 * 60 * 60 * 1000,
};

async function _checkBackupSchedule() {
  const { getScheduleConfig, runScheduledBackup } = await import('../routes/full-backup.js');
  const cfg = getScheduleConfig();
  if (cfg.schedule === 'off') return;
  const intervalMs = _BACKUP_INTERVAL_MS[cfg.schedule];
  if (!intervalMs) return;
  const [hh, mm] = cfg.time.split(':').map(n => parseInt(n, 10));
  const now = new Date();
  const scheduledMs = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0).getTime();
  if (now.getTime() < scheduledMs) return;
  if (cfg.lastAutoRun) {
    const lastMs = new Date(cfg.lastAutoRun).getTime();
    if (Number.isFinite(lastMs) && now.getTime() - lastMs < intervalMs) return;
  }
  logger.info(`[backup] auto-backup due (schedule=${cfg.schedule}, time=${cfg.time}, retention=${cfg.retention}, last=${cfg.lastAutoRun || 'never'})`);
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
    if (_withinWindow(localTime, time) && !_ranRecently(userId, 'workoutReminder', 3600000)) {
      // Check if workout already logged today
      const logged = userId
        ? db.prepare('SELECT 1 FROM workout_log WHERE user_id = ? AND date = ?').get(userId, today)
        : db.prepare('SELECT 1 FROM workout_log WHERE date = ?').get(today);
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
        ? db.prepare('SELECT 1 FROM workout_log WHERE user_id = ? AND date = ?').get(userId, yesterday)
        : db.prepare('SELECT 1 FROM workout_log WHERE date = ?').get(yesterday);
      const loggedToday = userId
        ? db.prepare('SELECT 1 FROM workout_log WHERE user_id = ? AND date = ?').get(userId, today)
        : db.prepare('SELECT 1 FROM workout_log WHERE date = ?').get(today);
      if (loggedYesterday && !loggedToday) {
        await pushNotify(userId, '🧘 Rest Day', 'Time to recover — hydrate, stretch, and refuel. See you tomorrow!', 3);
      }
    }
  }

  // ── Streak alert ──────────────────────────────────────────────────────
  const streakAlert = _getUserSetting(userId, 'notifStreakAlert', false);
  if (streakAlert) {
    const time = _getUserSetting(userId, 'notifStreakTime', '20:00');
    if (_withinWindow(localTime, time) && !_ranRecently(userId, 'streakAlert', 3600000)) {
      const logged = userId
        ? db.prepare('SELECT 1 FROM workout_log WHERE user_id = ? AND date = ?').get(userId, today)
        : db.prepare('SELECT 1 FROM workout_log WHERE date = ?').get(today);
      if (!logged) {
        // Calculate current streak
        let streak = 0;
        let checkDate = new Date();
        checkDate.setDate(checkDate.getDate() - 1); // start from yesterday
        while (true) {
          const ds = checkDate.toISOString().slice(0, 10);
          const row = userId
            ? db.prepare('SELECT 1 FROM workout_log WHERE user_id = ? AND date = ?').get(userId, ds)
            : db.prepare('SELECT 1 FROM workout_log WHERE date = ?').get(ds);
          if (!row) break;
          streak++;
          checkDate.setDate(checkDate.getDate() - 1);
        }
        if (streak > 0) {
          await pushNotify(userId, '🔥 Streak at Risk!', `Your ${streak}-day streak is on the line — log a workout today to keep it alive!`, 7);
        }
      }
    }
  }

  // ── Weekly summary ────────────────────────────────────────────────────
  const weeklySummary = _getUserSetting(userId, 'notifWeeklySummary', false);
  if (weeklySummary) {
    const targetDay = _getUserSetting(userId, 'weeklySummaryDay', 0);
    const targetTime = _getUserSetting(userId, 'weeklySummaryTime', '09:00');
    const currentDay = new Date().getDay();
    if (currentDay === targetDay && _withinWindow(localTime, targetTime, 30) && !_ranRecently(userId, 'weeklySummary', 6 * 24 * 3600000)) {
      const weekAgo = new Date(Date.now() - 7 * 24 * 3600000).toISOString().slice(0, 10);
      const logs = userId
        ? db.prepare('SELECT * FROM workout_log WHERE user_id = ? AND date >= ?').all(userId, weekAgo)
        : db.prepare('SELECT * FROM workout_log WHERE date >= ?').all(weekAgo);

      const workoutCount = logs.length;
      let totalVolume = 0;
      let prCount = 0;
      for (const log of logs) {
        const exercises = JSON.parse(log.exercises || '[]');
        for (const ex of exercises) {
          const lt = ex.load_type || 'bilateral';
          for (const set of (ex.sets || [])) {
            // Warm-up sets don't count toward reported volume (consistent
            // with all the other stats routes).
            if (set.completed && !set.warmup) totalVolume += setVolume(set, lt);
          }
        }
      }

      const summaryMsg = `This week: ${workoutCount} workouts, ${Math.round(totalVolume).toLocaleString()} volume lifted. Keep pushing!`;
      await pushNotify(userId, '📊 Weekly Summary', summaryMsg, 4);

      // Also send email if configured
      if (isEmailConfigured()) {
        const user = userId ? db.prepare('SELECT * FROM users WHERE id = ?').get(userId) : null;
        if (user?.email) {
          try {
            const origin = db.prepare("SELECT value FROM app_config WHERE key='app_url'").get()?.value || 'http://localhost:3003';
            await sendWeeklySummary(user.email, user.full_name || user.username, { workoutCount, totalVolume }, origin);
          } catch(e) {
            logger.warn(`[scheduler] weekly email failed: ${e.message}`);
          }
        }
      }
    }
  }
}

export function startScheduler() {
  logger.info('[scheduler] Starting 15-minute tick loop');
  // Run first tick after 30s (let server finish startup)
  setTimeout(() => {
    _tick();
    setInterval(_tick, TICK_MS);
  }, 30000);
}
