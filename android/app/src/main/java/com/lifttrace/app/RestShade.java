package com.lifttrace.app;

import android.app.AlarmManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import com.google.android.gms.wearable.DataMapItem;
import com.google.android.gms.wearable.PutDataMapRequest;
import com.google.android.gms.wearable.Wearable;

import org.json.JSONObject;

import java.util.Collections;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * The rest in the notification shade and on the lock screen while it runs.
 *
 * One ongoing notification for the whole rest: what you lift next, the time
 * left, and Skip Rest, +30s and Pause, so checking or changing the rest does
 * not need the phone unlocked and the app opened. Android draws the countdown
 * (a chronometer counting down to the end), so it is right with this app's
 * process long gone.
 *
 * The bar under it fills like the rest bar in the app. Android does not
 * animate a notification's bar, so it is redrawn about once a second, and
 * only while the screen is on and this process is alive: with the screen off
 * nobody can see it, and when the process is gone the chronometer still says
 * how long is left. Nothing here is a foreground service.
 *
 * Silent and local-only. The sound and the buzz are RestCues' alarms, and a
 * watch runs its own rest with its own words, so a copy mirrored to the wrist
 * would only be noise.
 *
 * The buttons act here, with or without the app: they change the record,
 * move the cues, tell a watch that is in use, and tell the app if it is
 * running. The app reads the record when it next comes to the front.
 */
final class RestShade {
    private static final String TAG = "RestShade";
    private static final String PREFS = "lifttrace.rest_shade";
    private static final String KEY = "rest";

    /** The channel "Rest complete" already uses: silent, the cues make the noise. */
    static final String CHANNEL_ID = "rest-timer-finish";
    static final int NOTE_ID = 9010;

    static final String ACTION_SKIP = "com.lifttrace.app.REST_SKIP";
    static final String ACTION_ADD = "com.lifttrace.app.REST_ADD";
    static final String ACTION_PAUSE = "com.lifttrace.app.REST_PAUSE";
    static final String ACTION_RESUME = "com.lifttrace.app.REST_RESUME";
    static final String ACTION_END = "com.lifttrace.app.REST_END";
    static final String ACTION_DISMISSED = "com.lifttrace.app.REST_DISMISSED";
    /** Tapping the notification: the Diary, on the rest's workout. */
    static final String ACTION_OPEN = "com.lifttrace.app.OPEN_REST";

    private static final int RC_SKIP = 9131, RC_ADD = 9132, RC_PAUSE = 9133, RC_RESUME = 9134,
        RC_DISMISSED = 9135, RC_END = 9136, RC_OPEN = 9137;

    private static final String REST_PATH = "/lifttrace/rest";
    private static final String AWAKE_PATH = "/lifttrace/awake";
    /** As src/lib/wear-pairing.js: a watch counts as in use this long after it was opened. */
    private static final long AWAKE_FOR = 30L * 60L * 1000L;

    /** The app, while it runs, hears about changes made here. */
    interface Listener { void changed(RestRecord r); }
    static volatile Listener listener;
    /**
     * The app's screen is in front. It then plays the countdown itself, so
     * a change made here leaves the alarms down and lets it.
     */
    static volatile boolean appInFront;

    private static RestRecord cached;
    private static final Handler main = new Handler(Looper.getMainLooper());
    private static Context appCtx;
    private static boolean ticking;
    private static BroadcastReceiver screen;

    private RestShade() {}

    // ── The record ───────────────────────────────────────────────────────

    static synchronized RestRecord load(Context ctx) {
        if (cached != null) return cached;
        RestRecord r = new RestRecord();
        try {
            String raw = prefs(ctx).getString(KEY, null);
            if (raw != null) {
                JSONObject o = new JSONObject(raw);
                r.active = o.optBoolean("active");
                r.paused = o.optBoolean("paused");
                r.endsAt = o.optLong("endsAt");
                r.leftMs = o.optLong("leftMs");
                r.total = o.optInt("total");
                r.startedAt = o.optLong("startedAt");
                r.at = o.optLong("at");
                r.date = o.optString("date");
                r.label = o.optString("label");
                r.title = o.optString("title");
                r.text = o.optString("text");
                r.fallbackTitle = o.optString("fallbackTitle");
                r.skip = o.optString("skip");
                r.add = o.optString("add");
                r.pause = o.optString("pause");
                r.resume = o.optString("resume");
                r.pausedText = o.optString("pausedText");
                r.pausedChip = o.optString("pausedChip");
                r.addSec = o.optInt("addSec", 30);
                r.accent = o.optString("accent", "#FF7433");
                r.dismissedFor = o.optLong("dismissedFor");
                r.onWatch = o.optBoolean("onWatch");
            }
        } catch (Exception e) {
            Log.w(TAG, "couldn't read the rest: " + e.getMessage());
        }
        cached = r;
        return r;
    }

    static synchronized void save(Context ctx, RestRecord r) {
        cached = r;
        try {
            JSONObject o = new JSONObject();
            o.put("active", r.active);
            o.put("paused", r.paused);
            o.put("endsAt", r.endsAt);
            o.put("leftMs", r.leftMs);
            o.put("total", r.total);
            o.put("startedAt", r.startedAt);
            o.put("at", r.at);
            o.put("date", r.date);
            o.put("label", r.label);
            o.put("title", r.title);
            o.put("text", r.text);
            o.put("fallbackTitle", r.fallbackTitle);
            o.put("skip", r.skip);
            o.put("add", r.add);
            o.put("pause", r.pause);
            o.put("resume", r.resume);
            o.put("pausedText", r.pausedText);
            o.put("pausedChip", r.pausedChip);
            o.put("addSec", r.addSec);
            o.put("accent", r.accent);
            o.put("dismissedFor", r.dismissedFor);
            o.put("onWatch", r.onWatch);
            prefs(ctx).edit().putString(KEY, o.toString()).apply();
        } catch (Exception e) {
            Log.w(TAG, "couldn't keep the rest: " + e.getMessage());
        }
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    // ── Changes ──────────────────────────────────────────────────────────

    /**
     * Everything that changes the rest runs on the main thread, where the
     * buttons, the alarms and the once-a-second redraw already run: the
     * plugin's calls and the watch listener arrive on threads of their own.
     */
    static void onMain(Runnable r) {
        if (Looper.myLooper() == Looper.getMainLooper()) r.run();
        else main.post(r);
    }

    /**
     * The app says what the rest is now (started, extended, paused, resumed,
     * stopped). An older word than the one held is ignored: a button on the
     * notification or the watch got there first, and the app hears about it.
     */
    static void fromApp(Context ctx, RestRecord r, boolean keepWords) {
        RestRecord had = load(ctx);
        if (r.at < had.at) return;
        boolean same = had.startedAt != 0L && had.startedAt == r.startedAt;
        // A swipe-away holds for the rest it was about, not for the next one.
        if (same && had.dismissedFor == had.startedAt) r.dismissedFor = had.dismissedFor;
        // A rest the app took up from here or the watch, with no next set of
        // its own to say: the words this rest already had stay.
        if (same && keepWords && had.title != null && !had.title.isEmpty()) {
            r.title = had.title;
            r.text = had.text;
        }
        if (same || r.at == had.at) r.onWatch = had.onWatch;
        save(ctx, r);
        refresh(ctx);
    }

    /** Last time arrived after the rest started: the words only, nothing else. */
    static void words(Context ctx, long startedAt, String title, String text) {
        RestRecord r = load(ctx);
        if (!r.active || r.startedAt != startedAt) return;
        r.title = title;
        r.text = text;
        save(ctx, r);
        refresh(ctx);
    }

    /** Whether the watch took the word stamped `at` (said after the app sent it). */
    static void watchTook(Context ctx, long at, boolean took) {
        RestRecord r = load(ctx);
        if (r.at != at) return;
        r.onWatch = took;
        save(ctx, r);
    }

    /** A button on the notification. */
    static void act(Context ctx, String action, Runnable done) {
        long now = System.currentTimeMillis();
        RestRecord r = load(ctx);
        // A watch that holds this rest paused hears how the pause ends.
        boolean force = r.onWatch && r.kind(now) == RestRecord.Kind.PAUSED;
        boolean changed;
        switch (action) {
            case ACTION_PAUSE:
                changed = r.pauseAt(now);
                if (changed) RestCues.hold(ctx);
                break;
            case ACTION_RESUME:
                changed = r.resumeAt(now);
                if (changed) armFor(ctx, r);
                break;
            case ACTION_ADD:
                changed = r.extendAt(r.addSec > 0 ? r.addSec : 30, now);
                if (changed && !r.paused) armFor(ctx, r);
                break;
            case ACTION_SKIP:
                changed = r.kind(now) != RestRecord.Kind.NONE;
                r.stopAt(now);
                RestCues.cancel(ctx);
                RestCues.forget(ctx);
                break;
            default:
                changed = false;
        }
        save(ctx, r);
        refresh(ctx);
        if (!changed) { done.run(); return; }
        tellApp(r);
        tellWatch(ctx, r, force, done);
    }

    /** The rest reached zero: the alarm that fires there, with or without the app. */
    static void atZero(Context ctx) {
        RestRecord r = load(ctx);
        long now = System.currentTimeMillis();
        // Only the rest that is actually over: one extended or paused since
        // this alarm was set has its own end, or none.
        if (r.active && !r.paused && r.endsAt <= now + 1500L) {
            // Not a new word, so not a new stamp: the app and the watch both
            // know where the deadline was.
            r.active = false;
            save(ctx, r);
            RestCues.forget(ctx);
        }
        refresh(ctx);
    }

    /** Swiped away: not put back for the rest of this rest. */
    static void dismissed(Context ctx) {
        RestRecord r = load(ctx);
        r.dismissedFor = r.startedAt;
        save(ctx, r);
        stopTicks();
    }

    /** The watch paused, resumed, extended or skipped the rest this phone is holding. */
    static void fromWatch(Context ctx, boolean cleared, boolean paused, long leftMs, long endsAt,
                          int total, String label, long at) {
        long now = System.currentTimeMillis();
        RestRecord r = load(ctx);
        if (!r.adoptWire(cleared, paused, leftMs, endsAt, total, label, at, now)) return;
        switch (r.kind(now)) {
            case PAUSED: RestCues.hold(ctx); break;
            case RUNNING: armFor(ctx, r); break;
            default: RestCues.cancel(ctx); RestCues.forget(ctx); break;
        }
        save(ctx, r);
        refresh(ctx);
        tellApp(r);
    }

    /** The cues against the rest's new end, unless the app is in front to play them. */
    private static void armFor(Context ctx, RestRecord r) {
        if (appInFront) RestCues.hold(ctx);
        else RestCues.shift(ctx, r.endsAt);
    }

    private static void tellApp(RestRecord r) {
        Listener l = listener;
        if (l == null) return;
        main.post(() -> { try { l.changed(r); } catch (Exception ignored) {} });
    }

    // ── The notification ─────────────────────────────────────────────────

    /** Post, update or take down the notification, from what the record says. */
    static void refresh(Context ctx) {
        Context app = ctx.getApplicationContext();
        appCtx = app;
        RestRecord r = load(app);
        long now = System.currentTimeMillis();
        RestRecord.Kind kind = r.kind(now);
        if (kind == RestRecord.Kind.NONE) {
            cancelEnd(app);
            stopTicks();
            unwatchScreen(app);
            cancelNote(app);
            return;
        }
        if (kind == RestRecord.Kind.RUNNING) scheduleEnd(app, r.endsAt);
        else cancelEnd(app);
        post(app, r, now);
        if (kind == RestRecord.Kind.RUNNING) {
            watchScreen(app);
            if (r.wantsTicks(screenOn(app), now)) startTicks();
            else stopTicks();
        } else {
            stopTicks();
            unwatchScreen(app);
        }
    }

    private static void post(Context ctx, RestRecord r, long now) {
        if (r.dismissed()) return;
        NotificationManagerCompat nm = NotificationManagerCompat.from(ctx);
        // Notifications off for the app: the rest still runs and still rings,
        // there is simply nowhere to show it.
        if (!nm.areNotificationsEnabled()) return;
        try {
            channel(ctx);
            nm.notify(NOTE_ID, build(ctx, r, now));
        } catch (SecurityException e) {
            Log.w(TAG, "not allowed to post the rest: " + e.getMessage());
        } catch (Exception e) {
            Log.w(TAG, "couldn't post the rest: " + e.getMessage());
        }
    }

    static android.app.Notification build(Context ctx, RestRecord r, long now) {
        boolean paused = r.kind(now) == RestRecord.Kind.PAUSED;
        int accent = accent(r.accent);
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_rest)
            .setContentTitle(r.titleOr())
            .setCategory(NotificationCompat.CATEGORY_STOPWATCH)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setSilent(true)
            .setOnlyAlertOnce(true)
            .setLocalOnly(true)
            .setColor(accent)
            .setContentIntent(open(ctx, r))
            .setDeleteIntent(broadcast(ctx, ACTION_DISMISSED, RC_DISMISSED))
            // A Live Update on Android 16 and later where the system allows it
            // (ongoing, a title, a plain or progress style, not colorized, no
            // custom views): the countdown then also sits in the status bar.
            // Elsewhere this is an extra nobody reads.
            .setRequestPromotedOngoing(true);

        // The bar fills as the rest goes, in the app's accent, like the rest
        // bar in the app.
        NotificationCompat.ProgressStyle bar = new NotificationCompat.ProgressStyle()
            .setStyledByProgress(true)
            .setProgressSegments(Collections.singletonList(
                new NotificationCompat.ProgressStyle.Segment(1000).setColor(accent)))
            .setProgress(r.progress(now));
        b.setStyle(bar);

        if (paused) {
            // The status bar chip has no countdown to show while paused.
            if (r.pausedChip != null && !r.pausedChip.isEmpty()) b.setShortCriticalText(r.pausedChip);
            b.setShowWhen(false)
                .setUsesChronometer(false)
                .setContentText(r.pausedLine(now))
                .addAction(0, r.resume, broadcast(ctx, ACTION_RESUME, RC_RESUME))
                .addAction(0, r.skip, broadcast(ctx, ACTION_SKIP, RC_SKIP));
        } else {
            b.setWhen(r.endsAt)
                .setShowWhen(true)
                .setUsesChronometer(true)
                .setChronometerCountDown(true)
                // No setTimeoutAfter: on Android 8 to 14 its alarm outlives a
                // re-post without one, and would take a paused rest's
                // notification down at the old deadline. ACTION_END (an
                // exact alarm) and the finale cue take it down at zero.
                .setContentText(r.text)
                .addAction(0, r.skip, broadcast(ctx, ACTION_SKIP, RC_SKIP))
                .addAction(0, r.add, broadcast(ctx, ACTION_ADD, RC_ADD))
                .addAction(0, r.pause, broadcast(ctx, ACTION_PAUSE, RC_PAUSE));
        }
        return b.build();
    }

    static void cancelNote(Context ctx) {
        try { NotificationManagerCompat.from(ctx).cancel(NOTE_ID); } catch (Exception ignored) {}
    }

    private static int accent(String hex) {
        try {
            if (hex != null && hex.matches("#[0-9a-fA-F]{6}")) return Color.parseColor(hex);
        } catch (Exception ignored) {}
        return 0xFFFF7433;
    }

    /** The channel "Rest complete" posts on too: silent, the cues make the noise. */
    static void channel(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null || nm.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID, "Rest timer", NotificationManager.IMPORTANCE_DEFAULT);
        channel.setDescription("When a rest between sets is over");
        channel.enableVibration(false);
        channel.setSound(null, null);
        nm.createNotificationChannel(channel);
    }

    private static PendingIntent open(Context ctx, RestRecord r) {
        Intent i = new Intent(ctx, MainActivity.class)
            .setAction(ACTION_OPEN)
            .putExtra("date", r.date == null ? "" : r.date)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(ctx, RC_OPEN, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static PendingIntent broadcast(Context ctx, String action, int code) {
        Intent i = new Intent(ctx, RestShadeReceiver.class).setAction(action);
        return PendingIntent.getBroadcast(ctx, code, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    // ── Zero ─────────────────────────────────────────────────────────────

    /**
     * Its own alarm at the end, whatever the sound and buzz settings are (with
     * both off there are no cues at all), so the notification goes at zero
     * with the app long gone.
     */
    private static void scheduleEnd(Context ctx, long endsAt) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        RestCues.exact(am, endsAt, broadcast(ctx, ACTION_END, RC_END));
    }

    private static void cancelEnd(Context ctx) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        Intent i = new Intent(ctx, RestShadeReceiver.class).setAction(ACTION_END);
        PendingIntent pi = PendingIntent.getBroadcast(ctx, RC_END, i, PendingIntent.FLAG_NO_CREATE | PendingIntent.FLAG_IMMUTABLE);
        if (pi != null) { am.cancel(pi); pi.cancel(); }
    }

    // ── The bar, once a second while somebody can see it ─────────────────

    private static final Runnable tick = new Runnable() {
        @Override public void run() {
            Context ctx = appCtx;
            if (ctx == null) { ticking = false; return; }
            RestRecord r = load(ctx);
            long now = System.currentTimeMillis();
            if (!r.wantsTicks(screenOn(ctx), now)) { ticking = false; return; }
            post(ctx, r, now);
            // On the second, so the bar and the chronometer move together.
            // Just after the chronometer's next whole second.
            long wait = (Math.max(0L, r.endsAt - now) % 1000L) + 50L;
            main.postDelayed(this, wait < 250L ? wait + 1000L : wait);
        }
    };

    private static void startTicks() {
        if (ticking) return;
        ticking = true;
        main.postDelayed(tick, 1000L);
    }

    private static void stopTicks() {
        ticking = false;
        main.removeCallbacks(tick);
    }

    private static boolean screenOn(Context ctx) {
        PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
        return pm == null || pm.isInteractive();
    }

    /** Off: stop drawing. On: draw at once, then keep going. */
    private static synchronized void watchScreen(Context app) {
        if (screen != null) return;
        screen = new BroadcastReceiver() {
            @Override public void onReceive(Context c, Intent intent) {
                if (Intent.ACTION_SCREEN_OFF.equals(intent.getAction())) {
                    stopTicks();
                } else {
                    RestRecord r = load(app);
                    long now = System.currentTimeMillis();
                    if (r.wantsTicks(true, now)) {
                        post(app, r, now);
                        startTicks();
                    }
                }
            }
        };
        IntentFilter f = new IntentFilter();
        f.addAction(Intent.ACTION_SCREEN_ON);
        f.addAction(Intent.ACTION_SCREEN_OFF);
        try {
            // System broadcasts: nothing else can send these, and on Android
            // 14+ a runtime receiver has to say whether others may.
            if (Build.VERSION.SDK_INT >= 33) app.registerReceiver(screen, f, Context.RECEIVER_NOT_EXPORTED);
            else app.registerReceiver(screen, f);
        } catch (Exception e) {
            screen = null;
        }
    }

    private static synchronized void unwatchScreen(Context app) {
        if (screen == null) return;
        try { app.unregisterReceiver(screen); } catch (Exception ignored) {}
        screen = null;
    }

    // ── The watch ────────────────────────────────────────────────────────

    /**
     * A change made on this notification, for a watch that is in use (opened
     * within half an hour, the rule src/lib/wear-pairing.js publishRest goes
     * by). Written the way restToWire writes it: a paused rest as cleared with
     * paused beside it, so a watch from before pausing takes the rest down
     * rather than ringing in the middle of a pause.
     */
    static void tellWatch(Context ctx, RestRecord r, boolean force, Runnable done) {
        AtomicBoolean finished = new AtomicBoolean(false);
        Runnable finish = () -> { if (finished.compareAndSet(false, true)) done.run(); };
        // A receiver has seconds, not minutes: never hold one open on a
        // watch that does not answer.
        main.postDelayed(finish, 8000L);
        try {
            Wearable.getDataClient(ctx).getDataItems()
                .addOnSuccessListener(items -> {
                    long awake = 0L;
                    for (com.google.android.gms.wearable.DataItem item : items) {
                        String path = item.getUri().getPath();
                        if (path == null || !path.startsWith(AWAKE_PATH)) continue;
                        long at = DataMapItem.fromDataItem(item).getDataMap().getLong("at", 0L);
                        if (at > awake) awake = at;
                    }
                    items.release();
                    if (!force && awake <= System.currentTimeMillis() - AWAKE_FOR) {
                        onMain(() -> watchTook(ctx, r.at, false));
                        finish.run();
                        return;
                    }
                    PutDataMapRequest req = PutDataMapRequest.create(REST_PATH);
                    long now = System.currentTimeMillis();
                    boolean paused = r.kind(now) == RestRecord.Kind.PAUSED;
                    boolean running = r.kind(now) == RestRecord.Kind.RUNNING;
                    req.getDataMap().putBoolean("cleared", !running);
                    req.getDataMap().putBoolean("paused", paused);
                    if (paused) {
                        req.getDataMap().putLong("leftMs", r.leftMs);
                        req.getDataMap().putString("label", r.label == null ? "" : r.label);
                        req.getDataMap().putInt("total", r.total);
                        req.getDataMap().putLong("endsAt", 0L);
                    } else if (running) {
                        req.getDataMap().putString("label", r.label == null ? "" : r.label);
                        req.getDataMap().putInt("total", r.total);
                        req.getDataMap().putLong("endsAt", r.endsAt);
                    }
                    req.getDataMap().putLong("at", r.at);
                    Wearable.getDataClient(ctx).putDataItem(req.asPutDataRequest().setUrgent())
                        .addOnCompleteListener(t -> {
                            boolean took = t.isSuccessful();
                            onMain(() -> watchTook(ctx, r.at, took));
                            finish.run();
                        });
                })
                .addOnFailureListener(e -> {
                    onMain(() -> watchTook(ctx, r.at, false));
                    finish.run();
                });
        } catch (Exception e) {
            finish.run();
        }
    }
}
