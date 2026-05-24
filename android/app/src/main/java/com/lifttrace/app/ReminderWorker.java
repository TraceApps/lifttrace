package com.lifttrace.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.os.Build;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import java.io.File;
import java.util.Calendar;
import java.util.Locale;

/**
 * ReminderWorker — periodic background job that posts smart workout
 * notifications without requiring the app to be open.
 *
 * Battery-conscious design:
 *   - Network constraint NONE (local DB only)
 *   - Read-only DB access
 *   - Returns immediately if no relevant time window matched
 *   - Per-day SharedPreferences de-dupe so each reminder only fires once
 *
 * Reads from the same SQLite database the JS app uses
 * (capacitor-community/sqlite stores it as <name>SQLite.db in databases/).
 */
public class ReminderWorker extends Worker {
    private static final String TAG = "LtReminderWorker";
    private static final String DB_FILENAME = "lifttraceSQLite.db";
    private static final String CHANNEL_ID = "lifttrace_reminders";
    private static final String PREFS_NAME = "lt_reminders_dedupe";

    private static final int ID_WORKOUT_REMINDER = 2001;
    private static final int ID_REST_DAY        = 2002;
    private static final int ID_STREAK_AT_RISK  = 2003;
    private static final int ID_WEEKLY_SUMMARY  = 2004;

    public ReminderWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context ctx = getApplicationContext();
        try {
            // Master kill switch: if the JS LocalNotifications path is in use,
            // don't run any native checks. Web settings UI flips this when
            // the user opts into native reminders.
            if (!WorkerScheduler.readBoolSetting(ctx, "_USE_NATIVE_WORKER")) {
                return Result.success();
            }

            File dbFile = ctx.getDatabasePath(DB_FILENAME);
            if (!dbFile.exists()) {
                Log.d(TAG, "DB missing — skipping");
                return Result.success();
            }

            ensureChannel(ctx);

            SQLiteDatabase db = SQLiteDatabase.openDatabase(
                dbFile.getAbsolutePath(), null, SQLiteDatabase.OPEN_READONLY);
            try {
                runChecks(ctx, db);
            } finally {
                db.close();
            }

            // Re-evaluate scheduling so toggles take effect within 15 min.
            WorkerScheduler.reschedule(ctx);
            return Result.success();
        } catch (Exception e) {
            Log.w(TAG, "worker failed: " + e.getMessage());
            return Result.success(); // never retry-spam
        }
    }

    private void runChecks(Context ctx, SQLiteDatabase db) {
        Calendar now = Calendar.getInstance();
        int currentMin = now.get(Calendar.HOUR_OF_DAY) * 60 + now.get(Calendar.MINUTE);
        int dayOfWeek = now.get(Calendar.DAY_OF_WEEK); // 1=Sun .. 7=Sat
        String today = String.format(Locale.US, "%04d-%02d-%02d",
            now.get(Calendar.YEAR), now.get(Calendar.MONTH) + 1, now.get(Calendar.DAY_OF_MONTH));

        if (getBool(db, "notifWorkoutReminder")) {
            int t = parseHHMM(getString(db, "notifWorkoutReminderTime", "17:00"));
            if (inWindow(currentMin, t)
                && !alreadyFired(ctx, "workout", today)
                && !hasLoggedToday(db, today)) {
                postNotification(ctx, ID_WORKOUT_REMINDER,
                    "🏋️ Time to Train",
                    "Open LiftTrace and crush today's workout.");
                markFired(ctx, "workout", today);
            }
        }

        if (getBool(db, "notifRestDay")) {
            int t = parseHHMM(getString(db, "notifRestDayTime", "09:00"));
            if (inWindow(currentMin, t) && !alreadyFired(ctx, "rest", today)) {
                postNotification(ctx, ID_REST_DAY,
                    "🧘 Rest Day",
                    "Stretch, hydrate, and recover well today.");
                markFired(ctx, "rest", today);
            }
        }

        if (getBool(db, "notifStreakAtRisk")) {
            int t = parseHHMM(getString(db, "notifStreakAtRiskTime", "20:00"));
            if (inWindow(currentMin, t)
                && !alreadyFired(ctx, "streak", today)
                && streakAtRisk(db, today)) {
                postNotification(ctx, ID_STREAK_AT_RISK,
                    "🔥 Streak at Risk",
                    "Don't break your streak — log a quick session.");
                markFired(ctx, "streak", today);
            }
        }

        // Weekly summary fires on the configured day (default Sunday=1)
        // The JS side stores the weekday as 0=Sun..6=Sat, so map +1.
        if (getBool(db, "notifWeeklySummary")) {
            String dayStr = getString(db, "notifWeeklySummaryDay", "0"); // 0=Sun
            int targetDay = 1 + parseInt(dayStr, 0);
            if (dayOfWeek == targetDay) {
                int t = parseHHMM(getString(db, "notifWeeklySummaryTime", "18:00"));
                String weekKey = today + "|wk";
                if (inWindow(currentMin, t) && !alreadyFired(ctx, "weekly", weekKey)) {
                    postNotification(ctx, ID_WEEKLY_SUMMARY,
                        "📊 Weekly Summary",
                        "Check this week's training volume + PRs.");
                    markFired(ctx, "weekly", weekKey);
                }
            }
        }
    }

    // ── Helpers ────────────────────────────────────────────────────────────

    private static boolean inWindow(int currentMin, int targetMin) {
        // Fire if we're within 15 minutes after the target time. The worker
        // tick is 15 min so this guarantees exactly one fire per day window.
        return currentMin >= targetMin && currentMin < targetMin + 15;
    }

    private static int parseHHMM(String s) {
        if (s == null) return 0;
        String[] hm = s.replace("\"", "").split(":");
        if (hm.length < 2) return 0;
        try { return Integer.parseInt(hm[0]) * 60 + Integer.parseInt(hm[1]); }
        catch (Exception e) { return 0; }
    }

    private static int parseInt(String s, int fallback) {
        if (s == null) return fallback;
        try { return Integer.parseInt(s.replace("\"", "").trim()); }
        catch (Exception e) { return fallback; }
    }

    private static boolean alreadyFired(Context ctx, String reminderKey, String dayKey) {
        SharedPreferences p = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        String existing = p.getString("fired:" + reminderKey, "");
        return dayKey.equals(existing);
    }

    private static void markFired(Context ctx, String reminderKey, String dayKey) {
        SharedPreferences p = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        p.edit().putString("fired:" + reminderKey, dayKey).apply();
    }

    private static boolean getBool(SQLiteDatabase db, String key) {
        Cursor c = db.rawQuery("SELECT value FROM user_settings WHERE key = ? LIMIT 1", new String[]{key});
        try {
            if (!c.moveToFirst()) return false;
            String v = c.getString(0);
            if (v == null) return false;
            v = v.replace("\"", "").trim();
            return "true".equalsIgnoreCase(v) || "1".equals(v);
        } finally { c.close(); }
    }

    private static String getString(SQLiteDatabase db, String key, String fallback) {
        Cursor c = db.rawQuery("SELECT value FROM user_settings WHERE key = ? LIMIT 1", new String[]{key});
        try {
            if (!c.moveToFirst()) return fallback;
            String v = c.getString(0);
            return v == null ? fallback : v.replace("\"", "").trim();
        } finally { c.close(); }
    }

    /** Did the user log any completed set today? Cheap heuristic: workout_log row with a non-empty exercises JSON. */
    private static boolean hasLoggedToday(SQLiteDatabase db, String today) {
        Cursor c = db.rawQuery(
            "SELECT exercises FROM workout_log WHERE user_id = 1 AND date = ? AND deleted_at IS NULL LIMIT 1",
            new String[]{today});
        try {
            if (!c.moveToFirst()) return false;
            String exs = c.getString(0);
            return exs != null && !exs.equals("[]") && exs.length() > 5;
        } finally { c.close(); }
    }

    /** Streak at risk = there's a current streak (yesterday had a workout) and today doesn't. */
    private static boolean streakAtRisk(SQLiteDatabase db, String today) {
        if (hasLoggedToday(db, today)) return false;
        Calendar yesterday = Calendar.getInstance();
        yesterday.add(Calendar.DAY_OF_MONTH, -1);
        String yKey = String.format(Locale.US, "%04d-%02d-%02d",
            yesterday.get(Calendar.YEAR), yesterday.get(Calendar.MONTH) + 1, yesterday.get(Calendar.DAY_OF_MONTH));
        Cursor c = db.rawQuery(
            "SELECT exercises FROM workout_log WHERE user_id = 1 AND date = ? AND deleted_at IS NULL LIMIT 1",
            new String[]{yKey});
        try {
            if (!c.moveToFirst()) return false;
            String exs = c.getString(0);
            return exs != null && exs.length() > 5 && !exs.equals("[]");
        } finally { c.close(); }
    }

    private static void ensureChannel(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm == null || nm.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel ch = new NotificationChannel(
            CHANNEL_ID, "LiftTrace Reminders",
            NotificationManager.IMPORTANCE_DEFAULT);
        ch.setDescription("Workout reminders, rest day suggestions, streak alerts.");
        nm.createNotificationChannel(ch);
    }

    private static void postNotification(Context ctx, int id, String title, String body) {
        if (!NotificationManagerCompat.from(ctx).areNotificationsEnabled()) return;
        try {
            NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .setAutoCancel(true);
            NotificationManagerCompat.from(ctx).notify(id, b.build());
        } catch (SecurityException se) {
            // POST_NOTIFICATIONS not granted on Android 13+
        }
    }
}
