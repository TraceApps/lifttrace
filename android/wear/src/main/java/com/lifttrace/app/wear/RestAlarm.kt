package com.lifttrace.app.wear

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.os.Build
import android.os.VibrationAttributes
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager

/**
 * The buzz at the end of a rest, set to happen whether or not the app is
 * still in front of you.
 *
 * A watch goes back to its face the moment your wrist drops, and an app that
 * is no longer on screen is not a reliable place to count from: the whole
 * point of a rest timer on a wrist is that you can stop looking at it. So the
 * countdown on screen is only the picture, and this is what actually rings.
 */
object RestAlarm {

    private const val ACTION = "com.lifttrace.app.wear.REST_OVER"
    private const val REQUEST = 41

    fun schedule(ctx: Context, endsAt: Long) {
        if (endsAt <= System.currentTimeMillis()) return
        val alarms = ctx.getSystemService(AlarmManager::class.java) ?: return
        val intent = pending(ctx)
        runCatching {
            // Exact, and awake through idle: a rest is 90 seconds, and a
            // minute of drift makes it useless.
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || alarms.canScheduleExactAlarms()) {
                alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, endsAt, intent)
            } else {
                alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, endsAt, intent)
            }
        }.onFailure {
            // Exact alarms turned off for this app: an approximate buzz is
            // still better than none, and the screen keeps the real count.
            runCatching { alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, endsAt, intent) }
        }
    }

    fun cancel(ctx: Context) {
        val alarms = ctx.getSystemService(AlarmManager::class.java) ?: return
        runCatching { alarms.cancel(pending(ctx)) }
    }

    private fun pending(ctx: Context): PendingIntent = PendingIntent.getBroadcast(
        ctx,
        REQUEST,
        Intent(ctx, RestAlarmReceiver::class.java).setAction(ACTION),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    /** Two short buzzes, which a sleeve does not hide. */
    fun buzz(ctx: Context) {
        val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            ctx.getSystemService(VibratorManager::class.java)?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            ctx.getSystemService(Vibrator::class.java)
        } ?: return
        // As an alarm, so it is not swallowed by whatever else the watch is
        // doing at the time.
        val effect = VibrationEffect.createWaveform(longArrayOf(0, 250, 150, 250), -1)
        runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                vibrator.vibrate(effect, VibrationAttributes.createForUsage(VibrationAttributes.USAGE_ALARM))
            } else {
                @Suppress("DEPRECATION")
                vibrator.vibrate(
                    effect,
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ALARM)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build(),
                )
            }
        }
    }
}

class RestAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        Pairing.clearTimer(context)
        // The rest is over, so it comes off the face with it.
        RestOngoing.hide(context)
        // A hold that was counting down is logged here rather than waiting for
        // anyone to be looking: holding a plank is exactly when the watch is
        // face down and the app is long gone from the screen.
        if (Pairing.completeHold(context)) {
            SessionTileService.refresh(context)
            SetsComplicationService.refresh(context)
        }
        RestAlarm.buzz(context)
    }
}
