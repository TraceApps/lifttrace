package com.lifttrace.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.res.AssetFileDescriptor;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.os.Build;
import android.os.PowerManager;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

/**
 * Fires audio + vibration for one rest-timer countdown beep WITHOUT
 * posting a notification.
 *
 * Scheduled by RestTimerCuePlugin via AlarmManager.setExactAndAllowWhileIdle
 * so each cue lands on the millisecond. Receives a `sound` (raw resource
 * name) and a `vibrate` flag in the intent extras. If `sound` is set, plays
 * the WAV via MediaPlayer with USAGE_NOTIFICATION_EVENT audio attributes —
 * that tells the system to duck other media (radio / Jellyfin / Spotify)
 * while the beep plays and restore volume when it ends. Vibration is a
 * single ~80ms pulse.
 *
 * A short PARTIAL_WAKE_LOCK keeps the CPU alive long enough for MediaPlayer
 * to finish; released as soon as audio completes (or 5s timeout).
 */
public class RestTimerCueReceiver extends BroadcastReceiver {
    private static final String TAG = "RestTimerCue";
    private static final String CHANNEL_ID = "rest-timer-finish";
    private static final int NOTE_ID = 9001;

    @Override
    public void onReceive(Context context, Intent intent) {
        final boolean vibrate = intent.getBooleanExtra("vibrate", false);
        final String  sound   = intent.getStringExtra("sound");
        final boolean isFinale = intent.getBooleanExtra("finale", false);

        PowerManager pm = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        final PowerManager.WakeLock wl = pm.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK, "lifttrace:rest-cue");
        wl.acquire(5000);

        if (vibrate) doVibrate(context, isFinale);

        if (isFinale) {
            postFinish(
                context,
                intent.getStringExtra("title"),
                intent.getStringExtra("body"),
                intent.getBooleanExtra("localOnly", false));
        }

        if (sound != null && !sound.isEmpty()) {
            playSound(context, sound, () -> {
                if (wl.isHeld()) try { wl.release(); } catch (Exception ignored) {}
            });
        } else {
            // No sound — release wake lock quickly. Vibration's already
            // fired (async by the OS), so nothing else to wait for.
            if (wl.isHeld()) try { wl.release(); } catch (Exception ignored) {}
        }
    }

    /**
     * "Rest complete", in the phone's own shade and nowhere else.
     *
     * Local-only when the watch has the rest itself. Wear OS mirrors a
     * phone's notifications to a paired watch by default, and a watch that is
     * already running the same rest will ring with its own alarm and its own
     * words; a second unlabelled copy arriving from the phone is a buzz the
     * wearer cannot account for. With no watch in the picture the mirror is
     * the only thing that would reach a wrist, so it is left alone.
     */
    private void postFinish(Context context, String title, String body, boolean localOnly) {
        if (title == null || title.isEmpty()) return;
        try {
            NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm.getNotificationChannel(CHANNEL_ID) == null) {
                NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID, "Rest timer", NotificationManager.IMPORTANCE_DEFAULT);
                channel.setDescription("When a rest between sets is over");
                channel.enableVibration(false);
                channel.setSound(null, null);
                nm.createNotificationChannel(channel);
            }
            Intent open = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
            PendingIntent tap = null;
            if (open != null) {
                open.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
                int flags = PendingIntent.FLAG_UPDATE_CURRENT;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
                tap = PendingIntent.getActivity(context, NOTE_ID, open, flags);
            }
            NotificationCompat.Builder b = new NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_rest)
                .setContentTitle(title)
                .setContentText(body == null ? "" : body)
                .setCategory(NotificationCompat.CATEGORY_ALARM)
                .setLocalOnly(localOnly)
                .setSilent(true)
                .setAutoCancel(true);
            if (tap != null) b.setContentIntent(tap);
            NotificationManagerCompat.from(context).notify(NOTE_ID, b.build());
        } catch (Exception e) {
            Log.w(TAG, "could not post the rest-complete notice: " + e.getMessage());
        }
    }

    private void doVibrate(Context context, boolean isFinale) {
        try {
            Vibrator vib;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                VibratorManager vm = (VibratorManager) context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE);
                vib = vm.getDefaultVibrator();
            } else {
                vib = (Vibrator) context.getSystemService(Context.VIBRATOR_SERVICE);
            }
            if (vib == null || !vib.hasVibrator()) return;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                if (isFinale) {
                    // Finale buzz is a double-pulse so the "0" feels distinct
                    // from the countdown beeps. Timing array: wait, vibrate,
                    // wait, vibrate. Amplitudes match a confident "done" feel.
                    long[] timings = { 0, 110, 90, 180 };
                    int[]  amps    = { 0, 200, 0, 255 };
                    vib.vibrate(VibrationEffect.createWaveform(timings, amps, -1));
                } else {
                    vib.vibrate(VibrationEffect.createOneShot(80, VibrationEffect.DEFAULT_AMPLITUDE));
                }
            } else {
                vib.vibrate(isFinale ? new long[] { 0, 110, 90, 180 } : new long[] { 0, 80 }, -1);
            }
        } catch (Exception e) {
            Log.w(TAG, "vibrate failed: " + e.getMessage());
        }
    }

    private void playSound(Context context, String soundName, Runnable onDone) {
        try {
            int resId = context.getResources().getIdentifier(soundName, "raw", context.getPackageName());
            if (resId == 0) { onDone.run(); return; }

            AssetFileDescriptor afd = context.getResources().openRawResourceFd(resId);
            if (afd == null) { onDone.run(); return; }

            final MediaPlayer mp = new MediaPlayer();
            // USAGE_NOTIFICATION_EVENT + CONTENT_TYPE_SONIFICATION is the
            // canonical "short alert over music" attribute set on Android.
            // The system auto-ducks USAGE_MEDIA streams (Spotify, Jellyfin,
            // our own radio) while this plays and restores volume on
            // completion. Same pattern Google Maps uses for turn-by-turn
            // voice over music.
            mp.setAudioAttributes(new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_EVENT)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build());

            mp.setDataSource(afd.getFileDescriptor(), afd.getStartOffset(), afd.getLength());
            afd.close();

            mp.setOnCompletionListener(player -> {
                try { player.release(); } catch (Exception ignored) {}
                onDone.run();
            });
            mp.setOnErrorListener((player, what, extra) -> {
                Log.w(TAG, "MediaPlayer error what=" + what + " extra=" + extra);
                try { player.release(); } catch (Exception ignored) {}
                onDone.run();
                return true;
            });
            mp.prepare();
            mp.start();
        } catch (Exception e) {
            Log.w(TAG, "playSound failed: " + e.getMessage());
            onDone.run();
        }
    }
}
