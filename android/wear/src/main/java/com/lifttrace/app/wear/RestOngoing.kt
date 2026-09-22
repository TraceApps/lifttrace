package com.lifttrace.app.wear

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.wear.ongoing.OngoingActivity
import androidx.wear.ongoing.Status

/**
 * The rest on the watch face and in the launcher while it counts, without the
 * app open.
 *
 * Between sets the watch is back on its face and the app is gone from the
 * screen, which is the moment you want to know how long is left. This posts
 * one ongoing notification and hangs an ongoing activity off it, which is
 * what the watch face and the launcher read.
 *
 * Nothing here wakes up to tick. The notification carries a deadline and the
 * system draws the counting, exactly as the alarm carries a deadline rather
 * than a countdown: it is posted when the rest starts, is extended or ends,
 * and at no other time. Updating the text ourselves every second is how a
 * watch app eats a battery, and it would buy nothing.
 *
 * The same entry CookTrace shows over a pan, so a timer looks the same on the
 * face whichever app set it.
 */
object RestOngoing {

    private const val CHANNEL = "rest"
    private const val NOTE_ID = 4300
    private const val RANG_ID = 4301

    /**
     * Post, update or take down the entry, from whatever the saved rest now
     * says. Called where the rest changes, never on a tick.
     */
    fun refresh(ctx: Context) {
        val now = System.currentTimeMillis()
        val rest = Pairing.timer(ctx)
        if (rest == null || rest.endsAt <= now) {
            hide(ctx)
            return
        }
        // Notifications turned off for the app: the rest still runs and still
        // buzzes, there is simply nowhere to show it.
        if (!NotificationManagerCompat.from(ctx).areNotificationsEnabled()) return

        channel(ctx)
        val title = if (rest.label.isBlank()) "Resting" else "Resting before " + rest.label
        val builder = NotificationCompat.Builder(ctx, CHANNEL)
            .setSmallIcon(R.drawable.ic_timer)
            .setContentTitle(title)
            .setCategory(NotificationCompat.CATEGORY_STOPWATCH)
            .setOngoing(true)
            // The buzz at the end is the alarm's job, and it is a proper
            // alarm; this is only something to look at.
            .setSilent(true)
            .setOnlyAlertOnce(true)
            // The stream card counts down by itself, in wall-clock time.
            .setWhen(rest.endsAt)
            .setUsesChronometer(true)
            .setChronometerCountDown(true)
            .setContentIntent(open(ctx))

        // The face reads the ongoing activity rather than the card, and its
        // clock runs on time since boot, not on the wall.
        val zero = SystemClock.elapsedRealtime() + (rest.endsAt - now)
        val status = Status.Builder()
            .addTemplate("#timer# · #label#")
            .addTemplate("#timer#")
            .addPart("timer", Status.TimerPart(zero))
            .addPart("label", Status.TextPart(title))
            .build()

        runCatching {
            OngoingActivity.Builder(ctx, CHANNEL, NOTE_ID, builder)
                .setStaticIcon(R.drawable.ic_timer)
                .setTouchIntent(open(ctx))
                .setStatus(status)
                .setTitle(title)
                .build()
                .apply(ctx)
            NotificationManagerCompat.from(ctx).notify(NOTE_ID, builder.build())
        }
    }

    fun hide(ctx: Context) {
        runCatching { NotificationManagerCompat.from(ctx).cancel(NOTE_ID) }
    }

    /**
     * It rang. The buzz on its own says something happened but not what, and
     * a watch buzzes for plenty of reasons, so this is what is left on screen
     * to answer that: which app, which lift, and a way back in.
     *
     * Silent, because the alarm has already done the buzzing as a proper
     * alarm; this is only the words.
     */
    fun rang(ctx: Context, label: String) {
        hide(ctx)
        if (!NotificationManagerCompat.from(ctx).areNotificationsEnabled()) return
        channel(ctx)
        val note = NotificationCompat.Builder(ctx, CHANNEL)
            .setSmallIcon(R.drawable.ic_timer)
            .setContentTitle("Rest over")
            .setContentText(
                if (label.isBlank()) "Your LiftTrace rest has finished."
                else "Back to $label.",
            )
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setSilent(true)
            .setAutoCancel(true)
            .setContentIntent(open(ctx))
            .build()
        runCatching { NotificationManagerCompat.from(ctx).notify(RANG_ID, note) }
    }

    /** Tapping it goes to the timer, not to wherever the app was left. */
    private fun open(ctx: Context): PendingIntent = PendingIntent.getActivity(
        ctx,
        NOTE_ID,
        Intent(ctx, MainActivity::class.java)
            .setAction(Intent.ACTION_MAIN)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(MainActivity.EXTRA_ROUTE, "timer"),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    private fun channel(ctx: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = ctx.getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(CHANNEL) != null) return
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL, "Rest", NotificationManager.IMPORTANCE_LOW).apply {
                description = "The rest between sets, while it counts"
                setShowBadge(false)
                enableVibration(false)
            }
        )
    }
}
