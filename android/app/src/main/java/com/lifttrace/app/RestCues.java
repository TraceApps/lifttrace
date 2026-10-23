package com.lifttrace.app;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The rest's sound and buzz, as exact alarms that fire RestTimerCueReceiver.
 *
 * The app arms these when it goes to the background, and takes them down when
 * it comes back (it plays the countdown itself then). They are also kept as a
 * plan measured back from the end of the rest (the app sends it with every
 * change to the rest), so the notification's buttons and the watch can move
 * them with the app in the background or closed: Pause takes them down,
 * Resume and +30s put them back against the new end.
 */
final class RestCues {
    private static final String TAG = "RestTimerCue";
    private static final String PREFS = "lifttrace.rest_cues";
    private static final String KEY_PLAN = "plan";
    // Pool of reusable alarm request codes, enough for the audio cue + the
    // vibration ticks + the finale. The same set is cancelled every time.
    static final int[] CUE_IDS = { 9101, 9102, 9103, 9104, 9105, 9106, 9107, 9108 };
    /** The "Rest complete" message the finale posts. */
    static final int FINISH_NOTE_ID = 9001;

    private RestCues() {}

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /**
     * Arm a batch, replacing any before it. With the end of the rest given,
     * the batch is also kept, so it can be moved when the rest is.
     */
    static int schedule(Context ctx, JSONArray cues, long endsAt) {
        // A fresh batch takes the last rest's "Rest complete" with it.
        try {
            androidx.core.app.NotificationManagerCompat.from(ctx).cancel(FINISH_NOTE_ID);
        } catch (Exception ignored) {}
        cancelAlarms(ctx);
        JSONArray plan = new JSONArray();
        int scheduled = 0;
        for (int i = 0; i < cues.length() && i < CUE_IDS.length; i++) {
            try {
                JSONObject c = cues.getJSONObject(i);
                long at = c.getLong("at");
                if (endsAt > 0) {
                    JSONObject kept = new JSONObject(c.toString());
                    kept.remove("at");
                    kept.put("offset", at - endsAt);
                    plan.put(kept);
                }
                if (arm(ctx, i, c, at)) scheduled++;
            } catch (Exception e) {
                Log.w(TAG, "skip cue " + i + ": " + e.getMessage());
            }
        }
        if (endsAt > 0) prefs(ctx).edit().putString(KEY_PLAN, plan.toString()).apply();
        return scheduled;
    }

    /** Keep a batch for later without arming it (the app is in front). */
    static void keep(Context ctx, JSONArray cues, long endsAt) {
        if (cues == null || endsAt <= 0) return;
        JSONArray plan = new JSONArray();
        for (int i = 0; i < cues.length() && i < CUE_IDS.length; i++) {
            try {
                JSONObject c = new JSONObject(cues.getJSONObject(i).toString());
                long at = c.getLong("at");
                c.remove("at");
                c.put("offset", at - endsAt);
                plan.put(c);
            } catch (Exception e) {
                Log.w(TAG, "skip cue " + i + ": " + e.getMessage());
            }
        }
        prefs(ctx).edit().putString(KEY_PLAN, plan.toString()).apply();
    }

    /** Put the kept batch back against a new end (Resume, +30s). */
    static int shift(Context ctx, long endsAt) {
        cancelAlarms(ctx);
        int scheduled = 0;
        try {
            JSONArray plan = new JSONArray(prefs(ctx).getString(KEY_PLAN, "[]"));
            for (int i = 0; i < plan.length() && i < CUE_IDS.length; i++) {
                JSONObject c = plan.getJSONObject(i);
                if (arm(ctx, i, c, endsAt + c.optLong("offset", 0L))) scheduled++;
            }
        } catch (Exception e) {
            Log.w(TAG, "couldn't move the rest's cues: " + e.getMessage());
        }
        return scheduled;
    }

    /** The alarms down, the plan kept (Pause). */
    static void hold(Context ctx) {
        cancelAlarms(ctx);
    }

    /**
     * Everything down, the "Rest complete" message with it. The plan stays:
     * the app takes the alarms down every time it comes to the front, and
     * the rest may still be resumed from the notification afterwards.
     */
    static void cancel(Context ctx) {
        try {
            androidx.core.app.NotificationManagerCompat.from(ctx).cancel(FINISH_NOTE_ID);
        } catch (Exception ignored) {}
        cancelAlarms(ctx);
    }

    /** The rest is over: nothing left to move. */
    static void forget(Context ctx) {
        prefs(ctx).edit().putString(KEY_PLAN, "[]").apply();
    }

    private static boolean arm(Context ctx, int index, JSONObject c, long at) {
        if (at <= System.currentTimeMillis()) return false; // already past
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return false;
        int id = CUE_IDS[index];
        Intent intent = new Intent(ctx, RestTimerCueReceiver.class);
        intent.setAction("com.lifttrace.app.REST_CUE_" + id);
        intent.putExtra("sound", c.optString("sound", ""));
        intent.putExtra("vibrate", c.optBoolean("vibrate", false));
        intent.putExtra("finale", c.optBoolean("finale", false));
        // The words that go with the finale, posted by the receiver rather
        // than by LocalNotifications, so they can be marked local-only: a
        // paired watch runs its own rest timer, and a second copy of this
        // arriving from the phone is a buzz the wearer cannot account for.
        intent.putExtra("title", c.optString("title", ""));
        intent.putExtra("body", c.optString("body", ""));
        intent.putExtra("localOnly", c.optBoolean("localOnly", false));
        // Played as an alarm, so it sounds through Do Not Disturb (Settings >
        // Workout). Off by default.
        intent.putExtra("alarm", c.optBoolean("alarm", false));

        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pi = PendingIntent.getBroadcast(ctx, id, intent, flags);
        return exact(am, at, pi);
    }

    /**
     * setExactAndAllowWhileIdle survives Doze, and exact timing is what makes
     * the countdown beeps line up with the audio. Where exact alarms are not
     * allowed, an approximate cue still beats none.
     */
    static boolean exact(AlarmManager am, long at, PendingIntent pi) {
        try {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || am.canScheduleExactAlarms()) {
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
            } else {
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
            }
            return true;
        } catch (Exception e) {
            try {
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
                return true;
            } catch (Exception ignored) {
                return false;
            }
        }
    }

    private static void cancelAlarms(Context ctx) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        for (int id : CUE_IDS) {
            try {
                Intent intent = new Intent(ctx, RestTimerCueReceiver.class);
                intent.setAction("com.lifttrace.app.REST_CUE_" + id);
                int flags = PendingIntent.FLAG_NO_CREATE;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
                PendingIntent pi = PendingIntent.getBroadcast(ctx, id, intent, flags);
                if (pi != null) { am.cancel(pi); pi.cancel(); }
            } catch (Exception ignored) {}
        }
    }
}
