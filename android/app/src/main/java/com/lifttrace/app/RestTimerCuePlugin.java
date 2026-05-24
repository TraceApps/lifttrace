package com.lifttrace.app;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

/**
 * RestTimerCue — schedules AlarmManager broadcasts that fire SHORT
 * audio + vibration cues without posting any notification. The
 * BroadcastReceiver runs RestTimerCueReceiver, which uses MediaPlayer
 * with USAGE_NOTIFICATION_EVENT (so music ducks while the beep plays)
 * and the system Vibrator API.
 *
 * Why this exists: Capacitor's LocalNotifications is the only stock way
 * to fire sound/vibration while the WebView is suspended, but every
 * notification it posts is visible in the shade. Users were getting 4-5
 * stacked rest-timer rows per countdown. This plugin bypasses the
 * notification layer entirely for the countdown beeps; only the final
 * "Rest complete" message remains as a LocalNotification.
 *
 * JS contract:
 *   await RestTimerCue.schedule({ cues: [
 *     { at: 1234567890123, sound: "lt_tone_classic", vibrate: false, finale: false },
 *     { at: 1234567891123, sound: null,              vibrate: true,  finale: false },
 *     ...
 *   ]});
 *   await RestTimerCue.cancel();
 */
@CapacitorPlugin(name = "RestTimerCue")
public class RestTimerCuePlugin extends Plugin {
    private static final String TAG = "RestTimerCue";
    // Pool of reusable alarm request codes — enough for the audio cue +
    // 4-5 vibration ticks per countdown. Same set is cancelled on each
    // schedule call to wipe any leftover alarms from a previous timer.
    private static final int[] CUE_IDS = { 9101, 9102, 9103, 9104, 9105, 9106, 9107, 9108 };

    @PluginMethod
    public void schedule(PluginCall call) {
        JSArray cues = call.getArray("cues");
        if (cues == null) { call.reject("cues array is required"); return; }

        cancelAll();

        Context ctx = getContext();
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am == null) { call.reject("AlarmManager unavailable"); return; }

        int scheduled = 0;
        long now = System.currentTimeMillis();
        for (int i = 0; i < cues.length() && i < CUE_IDS.length; i++) {
            try {
                JSONObject c = cues.getJSONObject(i);
                long at = c.getLong("at");
                if (at <= now) continue; // already past — skip
                String sound = c.optString("sound", "");
                boolean vibrate = c.optBoolean("vibrate", false);
                boolean finale  = c.optBoolean("finale", false);
                int id = CUE_IDS[i];

                Intent intent = new Intent(ctx, RestTimerCueReceiver.class);
                intent.setAction("com.lifttrace.app.REST_CUE_" + id);
                intent.putExtra("sound", sound);
                intent.putExtra("vibrate", vibrate);
                intent.putExtra("finale", finale);

                int flags = PendingIntent.FLAG_UPDATE_CURRENT;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
                PendingIntent pi = PendingIntent.getBroadcast(ctx, id, intent, flags);

                // setExactAndAllowWhileIdle survives Doze. Exact timing is
                // what makes the countdown beeps line up cleanly with the
                // audio waveform; setAndAllowWhileIdle alone gets coalesced
                // by the OS into windows of seconds-to-minutes.
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
                scheduled++;
            } catch (Exception e) {
                Log.w(TAG, "skip cue " + i + ": " + e.getMessage());
            }
        }
        JSObject ret = new JSObject();
        ret.put("scheduled", scheduled);
        call.resolve(ret);
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        cancelAll();
        call.resolve();
    }

    private void cancelAll() {
        Context ctx = getContext();
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
