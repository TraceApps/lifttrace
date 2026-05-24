package com.lifttrace.app;

import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.util.Log;

import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;

import java.io.File;
import java.util.concurrent.TimeUnit;

/**
 * Centralized worker scheduling for LiftTrace's Android build. Mirrors the
 * NutriTrace pattern: read SQLite settings, decide which workers to enqueue
 * or cancel. Called from MainActivity on app start, and from ReminderWorker
 * on every 15-min tick so Settings toggles take effect within 15 minutes
 * without needing the app to be reopened.
 *
 * Only the reminder worker is active in v0.10.x — Health Connect is opted
 * out (the user explicitly said skip during scaffolding).
 */
public class WorkerScheduler {
    private static final String TAG = "LtWorkerScheduler";
    private static final String DB_FILENAME = "lifttraceSQLite.db";
    public static final String REMINDER_WORK = "lifttrace_reminders";

    public static void reschedule(Context context) {
        // Reminder worker is always enqueued; the worker itself reads each
        // notification toggle internally and skips checks for disabled types.
        // No outer gate so toggling any one reminder takes effect on next tick.
        enqueueReminderWorker(context);
    }

    private static void enqueueReminderWorker(Context context) {
        // Don't gate on setRequiresBatteryNotLow — Android treats "not low"
        // as <15% battery, which silently suppresses every reminder for the
        // rest of the day on phones that hover near low battery. Reminder
        // worker is cheap enough to run regardless. (Same fix shipped on
        // NutriTrace 2026-05-01 in c34c716 after a user-reported symptom.)
        Constraints constraints = new Constraints.Builder()
            .setRequiredNetworkType(NetworkType.NOT_REQUIRED)
            .build();

        PeriodicWorkRequest request = new PeriodicWorkRequest.Builder(
                ReminderWorker.class, 15, TimeUnit.MINUTES)
            .setConstraints(constraints)
            .build();

        WorkManager.getInstance(context)
            .enqueueUniquePeriodicWork(
                REMINDER_WORK,
                ExistingPeriodicWorkPolicy.KEEP,
                request);
    }

    /** Read a boolean setting from the JS app's SQLite user_settings table. */
    static boolean readBoolSetting(Context context, String key) {
        File dbFile = context.getDatabasePath(DB_FILENAME);
        if (!dbFile.exists()) return false;
        SQLiteDatabase db = null;
        Cursor c = null;
        try {
            db = SQLiteDatabase.openDatabase(
                dbFile.getAbsolutePath(), null, SQLiteDatabase.OPEN_READONLY);
            c = db.rawQuery(
                "SELECT value FROM user_settings WHERE key = ? LIMIT 1",
                new String[]{key});
            if (c.moveToFirst()) {
                String v = c.getString(0);
                if (v == null) return false;
                v = v.replace("\"", "").trim();
                return "true".equalsIgnoreCase(v) || "1".equals(v);
            }
        } catch (Exception e) {
            Log.w(TAG, "setting read failed for " + key + ": " + e.getMessage());
        } finally {
            if (c != null) c.close();
            if (db != null) db.close();
        }
        return false;
    }

    /** Read a string setting (e.g. "17:00") from user_settings. */
    static String readStringSetting(Context context, String key, String fallback) {
        File dbFile = context.getDatabasePath(DB_FILENAME);
        if (!dbFile.exists()) return fallback;
        SQLiteDatabase db = null;
        Cursor c = null;
        try {
            db = SQLiteDatabase.openDatabase(
                dbFile.getAbsolutePath(), null, SQLiteDatabase.OPEN_READONLY);
            c = db.rawQuery(
                "SELECT value FROM user_settings WHERE key = ? LIMIT 1",
                new String[]{key});
            if (c.moveToFirst()) {
                String v = c.getString(0);
                if (v == null) return fallback;
                v = v.replace("\"", "").trim();
                return v.isEmpty() ? fallback : v;
            }
        } catch (Exception e) {
            Log.w(TAG, "setting read failed for " + key + ": " + e.getMessage());
        } finally {
            if (c != null) c.close();
            if (db != null) db.close();
        }
        return fallback;
    }
}
