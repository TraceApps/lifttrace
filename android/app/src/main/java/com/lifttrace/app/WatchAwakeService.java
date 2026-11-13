package com.lifttrace.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

import androidx.core.app.NotificationCompat;

/**
 * Keeps LiftTrace awake while the watch is working through this phone in
 * Local mode (#156). Android freezes an app a few others have been opened
 * after, and a frozen app can't answer the watch, so while the watch has been
 * used lately the app runs as a foreground service with a quiet notification.
 *
 * Started as the app leaves the screen (WearPairingPlugin.keepAwake), with a
 * watch connected or used in the last 30 minutes. It ends itself 30 minutes
 * after the app left the screen or the watch's last request, whichever is
 * later, or when the app is back on screen.
 */
public class WatchAwakeService extends Service {
    private static final String TAG = "WatchAwake";
    private static final String CHANNEL_ID = "lifttrace_watch";
    private static final int NOTIFICATION_ID = 7156;
    static final long IDLE_MS = 30L * 60L * 1000L;
    private static final long CHECK_EVERY_MS = 60L * 1000L;

    /** When the watch last asked this phone something (WearPairingPlugin). */
    static volatile long lastWatchRequestAt = 0L;
    /** When the app last left the screen with this running. */
    private volatile long startedAt = 0L;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable check = new Runnable() {
        @Override public void run() {
            if (System.currentTimeMillis() - Math.max(startedAt, lastWatchRequestAt) > IDLE_MS) {
                Log.i(TAG, "the watch has been quiet for 30 minutes: stopping");
                stopSelf();
                return;
            }
            handler.postDelayed(this, CHECK_EVERY_MS);
        }
    };

    /** Whether the watch asked something recently enough to keep the app awake for it. */
    static boolean watchInUse() {
        return System.currentTimeMillis() - lastWatchRequestAt <= IDLE_MS;
    }

    static void start(Context ctx, String title, String text) {
        Intent i = new Intent(ctx, WatchAwakeService.class).putExtra("title", title).putExtra("text", text);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i);
            else ctx.startService(i);
        } catch (Exception e) {
            // Android refuses a start from the background: the watch then
            // works while the app hasn't been frozen, as it would without this.
            Log.w(TAG, "couldn't keep the app awake: " + e.getMessage());
        }
    }

    static void stop(Context ctx) {
        ctx.stopService(new Intent(ctx, WatchAwakeService.class));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String title = intent == null ? null : intent.getStringExtra("title");
        String text = intent == null ? null : intent.getStringExtra("text");
        Notification n = notification(title == null ? "LiftTrace" : title, text == null ? "" : text);
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
            } else {
                startForeground(NOTIFICATION_ID, n);
            }
        } catch (Exception e) {
            Log.w(TAG, "couldn't run in the foreground: " + e.getMessage());
            stopSelf();
            return START_NOT_STICKY;
        }
        startedAt = System.currentTimeMillis();
        handler.removeCallbacks(check);
        handler.postDelayed(check, CHECK_EVERY_MS);
        // Not brought back after the app is gone: nothing would answer the watch.
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacks(check);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    private Notification notification(String title, String text) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null && nm.getNotificationChannel(CHANNEL_ID) == null) {
                NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Watch", NotificationManager.IMPORTANCE_LOW);
                channel.setDescription("While your watch is working through this phone");
                channel.setSound(null, null);
                channel.enableVibration(false);
                channel.setShowBadge(false);
                nm.createNotificationChannel(channel);
            }
        }
        Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent tap = open == null ? null : PendingIntent.getActivity(this, 0, open,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_watch)
            .setContentTitle(title)
            .setContentText(text)
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE);
        if (tap != null) b.setContentIntent(tap);
        return b.build();
    }
}
