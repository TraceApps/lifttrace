package com.lifttrace.app.wear

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import com.google.android.gms.wearable.DataMap
import com.google.android.gms.wearable.DataMapItem
import com.google.android.gms.wearable.PutDataMapRequest
import com.google.android.gms.wearable.Wearable
import kotlinx.coroutines.tasks.await
import org.json.JSONArray
import org.json.JSONObject

/**
 * What the watch needs to reach the server, the last session it saw, and any
 * sets logged while it could not.
 *
 * The phone sends the address and a token once over the Wearable Data Layer
 * (PairingService picks them up). Nothing is asked of the wearer: there is no
 * keyboard on a watch worth typing a server address into.
 *
 * The cache is what makes the watch useful in a gym with no signal: the last
 * session is drawn the instant it wakes, and a set logged there waits in the
 * outbox until the server can be reached.
 */
object Pairing {

    data class Config(val serverUrl: String, val token: String)

    private const val TAG = "LiftTraceWear"
    private const val PREFS = "lifttrace.wear"
    const val KEY_URL = "server_url"
    const val KEY_TOKEN = "token"
    private const val KEY_CACHE = "cache"
    private const val KEY_CACHE_AT = "cache_at"
    private const val KEY_SETTINGS = "settings"
    private const val KEY_OUTBOX = "outbox"
    private const val KEY_SEQ = "outbox_seq"
    const val KEY_HOLD = "pending_hold"
    const val KEY_TIMER = "timer"
    private const val KEY_REST_AT = "rest_at"
    const val KEY_SESSION = "session_timer"
    private const val KEY_SESSION_AT = "session_timer_at"
    private const val KEY_LASTS = "last_times"
    private const val KEY_LASTS_DAY = "last_times_day"
    private const val KEY_REFUSED = "refused_token"
    /** When the phone last said it saved the day (an open app reads it again). */
    const val KEY_DAY = "day_saved_at"
    private const val KEY_PHONE_RELEASE = "phone_release"
    /** A workout finished here whose summary hasn't been looked at: "date|id". */
    const val KEY_FINISHED = "finished_unseen"

    private fun prefs(ctx: Context): SharedPreferences =
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /**
     * Tell me when any of this changes. The phone's half arrives on a
     * background service, so without this the app would sit there showing
     * what it read when it opened until something else made it look again.
     */
    fun watch(ctx: Context, onChange: (String) -> Unit): SharedPreferences.OnSharedPreferenceChangeListener {
        val listener = SharedPreferences.OnSharedPreferenceChangeListener { _, key ->
            if (key != null) onChange(key)
        }
        prefs(ctx).registerOnSharedPreferenceChangeListener(listener)
        return listener
    }

    /** The phone saved the day: noted, so an open app reads it again at once. */
    fun noteDaySaved(ctx: Context) {
        prefs(ctx).edit().putLong(KEY_DAY, System.currentTimeMillis()).apply()
    }

    /**
     * This watch saved the day: the phone reads it again at once. Without
     * this it found out at its next sync, up to half a minute later, and a
     * set logged here wasn't there when you looked.
     */
    fun tellPhoneDaySaved(ctx: Context, date: String) {
        val payload = date.toByteArray(Charsets.UTF_8)
        runCatching {
            Wearable.getNodeClient(ctx).connectedNodes.addOnSuccessListener { nodes ->
                for (node in nodes) {
                    Wearable.getMessageClient(ctx).sendMessage(node.id, PairingService.DAY_PATH, payload)
                }
            }
        }.onFailure { Log.w(TAG, "couldn't tell the phone about the day: " + it.message) }
    }

    /** The saved link, or null when the phone hasn't paired yet. */
    fun config(ctx: Context): Config? {
        val p = prefs(ctx)
        val url = p.getString(KEY_URL, null)?.takeIf { it.isNotBlank() }
        val token = p.getString(KEY_TOKEN, null)?.takeIf { it.isNotBlank() }
        return if (url != null && token != null) Config(url, token) else null
    }

    /**
     * Read whatever the phone has already published, rather than only waiting
     * for onDataChanged. A listener only fires on a change, so an app opened
     * after the phone published would sit there saying "pair from your phone"
     * with the pairing sitting right there unread.
     */
    suspend fun pullFromPhone(ctx: Context): Config? {
        val existing = config(ctx)
        return try {
            val items = Wearable.getDataClient(ctx).getDataItems().await()
            var found: Config? = null
            for (item in items) {
                val path = item.uri.path.orEmpty()
                if (path.startsWith(PairingService.TIMER_PATH)) {
                    // putSession ignores anything older than what is known,
                    // so the newest wins whatever order these arrive in.
                    putSession(ctx, DataMapItem.fromDataItem(item).dataMap)
                    continue
                }
                if (!path.startsWith(PairingService.PATH)) continue
                val map = DataMapItem.fromDataItem(item).dataMap
                val url = map.getString("serverUrl").orEmpty()
                val token = map.getString("token").orEmpty()
                if (url.isBlank() || token.isBlank()) continue
                if (token == prefs(ctx).getString(KEY_REFUSED, null)) continue
                save(ctx, url, token)
                found = Config(url.trimEnd('/'), token)
            }
            items.release()
            found ?: existing
        } catch (e: Exception) {
            Log.w(TAG, "couldn't read the pairing: " + e.message)
            existing
        }
    }

    fun save(ctx: Context, serverUrl: String, token: String, phoneRelease: String = "") {
        val edit = prefs(ctx).edit()
            .putString(KEY_URL, serverUrl.trim().trimEnd('/'))
            .putString(KEY_TOKEN, token.trim())
            // A fresh token: whatever was refused before is history.
            .remove(KEY_REFUSED)
        // A phone that doesn't say (an older app) has no release to follow.
        if (phoneRelease.isNotBlank()) edit.putString(KEY_PHONE_RELEASE, phoneRelease.trim())
        else edit.remove(KEY_PHONE_RELEASE)
        edit.apply()
    }

    /** The release the phone runs (v1.4.0-dev05), as it last said. */
    fun phoneRelease(ctx: Context): String? = prefs(ctx).getString(KEY_PHONE_RELEASE, null)?.takeIf { it.isNotBlank() }

    /**
     * The token stopped working. The address, the cached session and anything
     * waiting in the outbox are kept: the wearer hasn't signed out, and the
     * phone hands over a fresh token the next time it is opened.
     */
    fun forget(ctx: Context) {
        val refused = prefs(ctx).getString(KEY_TOKEN, null).orEmpty()
        prefs(ctx).edit().remove(KEY_TOKEN).putString(KEY_REFUSED, refused).apply()
    }

    /** The phone says the account signed out, or the watch was unpaired. */
    fun clear(ctx: Context) {
        prefs(ctx).edit().remove(KEY_URL).remove(KEY_TOKEN).remove(KEY_REFUSED)
            .remove(KEY_CACHE).remove(KEY_SETTINGS).remove(KEY_OUTBOX).remove(KEY_TIMER)
            .remove(KEY_LASTS).remove(KEY_LASTS_DAY).remove(KEY_SESSION).remove(KEY_SESSION_AT)
            .remove(KEY_FINISHED).apply()
    }

    // ── The last session the watch saw ───────────────────────────────────

    fun cache(ctx: Context): String? = prefs(ctx).getString(KEY_CACHE, null)

    fun cachedAt(ctx: Context): Long = prefs(ctx).getLong(KEY_CACHE_AT, 0L)

    fun putCache(ctx: Context, body: String) {
        prefs(ctx).edit()
            .putString(KEY_CACHE, body)
            .putLong(KEY_CACHE_AT, System.currentTimeMillis())
            .apply()
    }

    /** Rest length, auto-start and the weight unit, as the account has them. */
    fun settings(ctx: Context): JSONObject? =
        prefs(ctx).getString(KEY_SETTINGS, null)?.let { runCatching { JSONObject(it) }.getOrNull() }

    /**
     * Only what the watch actually reads. The settings a LiftTrace account
     * holds include API keys, a radio password and notification tokens, and
     * none of that has any business sitting on a wrist: four values decide how
     * this app behaves, so four values are what it keeps.
     */
    private val KEPT_SETTINGS = listOf("restDuration", "restAutoStart", "restTimerEnabled", "weightUnit")

    fun putSettings(ctx: Context, settings: JSONObject) {
        val kept = JSONObject()
        for (key in KEPT_SETTINGS) if (settings.has(key)) kept.put(key, settings.get(key))
        prefs(ctx).edit().putString(KEY_SETTINGS, kept.toString()).apply()
    }

    // ── How long the session has been running ────────────────────────────

    /**
     * The phone's workout timer, as it last said it stood. A start time and a
     * running total rather than a count, so the watch keeps counting with the
     * phone nowhere nearby.
     */
    data class SessionTimer(
        val date: String,
        val startTime: Long,
        val baseElapsedSec: Double,
        val paused: Boolean,
        val pausedElapsedSec: Double,
    ) {
        fun elapsedMs(now: Long): Long =
            if (paused) (pausedElapsedSec * 1000).toLong()
            else maxOf(0L, (baseElapsedSec * 1000).toLong() + (now - startTime))

        /** Held where it stands, with the total it had reached. */
        fun pausedAt(now: Long): SessionTimer =
            copy(paused = true, pausedElapsedSec = elapsedMs(now) / 1000.0)

        /** Counting again from now, on top of what it had already run. */
        fun resumedAt(now: Long): SessionTimer =
            copy(startTime = now, baseElapsedSec = pausedElapsedSec, paused = false, pausedElapsedSec = 0.0)

        /** The length to write onto the session, rounded as the phone rounds it. */
        fun minutes(now: Long): Double = Math.round(elapsedMs(now) / 6000.0) / 10.0
    }

    fun session(ctx: Context): SessionTimer? {
        val raw = prefs(ctx).getString(KEY_SESSION, null) ?: return null
        val o = runCatching { JSONObject(raw) }.getOrNull() ?: return null
        val date = o.optString("date")
        if (date.isBlank()) return null
        val timer = SessionTimer(
            date = date,
            startTime = o.optLong("startTime", 0L),
            baseElapsedSec = o.optDouble("baseElapsed", 0.0),
            paused = o.optBoolean("paused", false),
            pausedElapsedSec = o.optDouble("pausedElapsed", 0.0),
        )
        return if (sane(timer)) timer else null
    }

    /**
     * A timer that can't be right is no timer. The phone once sent a start
     * time of 0 (its plugin dropped any number in milliseconds), so the watch
     * counted from 1970: 497712 hours. One kept like that goes.
     */
    fun sane(timer: SessionTimer): Boolean =
        if (timer.paused) timer.pausedElapsedSec in 0.0..1e7
        // A pause or resume of one counting from 1970 carries it forward here.
        else timer.startTime > 1_000_000_000_000L && timer.baseElapsedSec in 0.0..1e7

    /**
     * Something the phone (or this watch) said about the timer. Anything older
     * than what is already known is ignored: both devices keep their own
     * record at this path, so an older one arriving afterwards is normal and
     * must not undo the newer one.
     */
    fun putSession(ctx: Context, map: com.google.android.gms.wearable.DataMap) {
        val at = map.getLong("at", 0L)
        if (at > 0 && at < prefs(ctx).getLong(KEY_SESSION_AT, 0L)) return
        if (map.getBoolean("cleared", false)) {
            clearSession(ctx, at)
            return
        }
        val o = JSONObject()
            .put("date", map.getString("date").orEmpty())
            .put("startTime", map.getLong("startTime"))
            .put("baseElapsed", map.getDouble("baseElapsed"))
            .put("paused", map.getBoolean("paused"))
            .put("pausedElapsed", map.getDouble("pausedElapsed"))
        prefs(ctx).edit()
            .putString(KEY_SESSION, o.toString())
            .putLong(KEY_SESSION_AT, if (at > 0) at else System.currentTimeMillis())
            .apply()
    }

    /**
     * Forget the running timer. The stamp only moves when the clearing was
     * itself dated: stamping an undated one with the time of day would shut
     * out every record older than this moment, including the very one that
     * is about to arrive from the other device.
     */
    fun clearSession(ctx: Context, at: Long = 0L) {
        val edit = prefs(ctx).edit().remove(KEY_SESSION)
        if (at > 0) edit.putLong(KEY_SESSION_AT, at)
        edit.apply()
    }

    /**
     * The wearer started, paused or stopped the timer. It is written down here
     * and told to the phone, which is what writes the session's length onto
     * the day when the workout is finished there.
     */
    fun publishSession(ctx: Context, timer: SessionTimer?) {
        val at = System.currentTimeMillis()
        if (timer == null) clearSession(ctx, at) else putSession(ctx, timer, at)
        val request = PutDataMapRequest.create(PairingService.TIMER_PATH)
        request.dataMap.apply {
            if (timer == null) {
                putBoolean("cleared", true)
            } else {
                putBoolean("cleared", false)
                putString("date", timer.date)
                putLong("startTime", timer.startTime)
                putDouble("baseElapsed", timer.baseElapsedSec)
                putBoolean("paused", timer.paused)
                putDouble("pausedElapsed", timer.pausedElapsedSec)
            }
            putLong("at", at)
        }
        runCatching {
            Wearable.getDataClient(ctx).putDataItem(request.asPutDataRequest().setUrgent())
        }.onFailure { Log.w(TAG, "couldn't tell the phone about the timer: " + it.message) }
    }

    private fun putSession(ctx: Context, timer: SessionTimer, at: Long) {
        val o = JSONObject()
            .put("date", timer.date)
            .put("startTime", timer.startTime)
            .put("baseElapsed", timer.baseElapsedSec)
            .put("paused", timer.paused)
            .put("pausedElapsed", timer.pausedElapsedSec)
        prefs(ctx).edit().putString(KEY_SESSION, o.toString()).putLong(KEY_SESSION_AT, at).apply()
    }

    // ── What you did last time ───────────────────────────────────────────

    /**
     * One line per exercise, worked out once a day and kept, so the number is
     * there in a gym with no signal as well as one with.
     */
    fun lastTimes(ctx: Context): Map<String, String> {
        val raw = prefs(ctx).getString(KEY_LASTS, null) ?: return emptyMap()
        val o = runCatching { JSONObject(raw) }.getOrNull() ?: return emptyMap()
        val out = mutableMapOf<String, String>()
        for (key in o.keys()) out[key] = o.optString(key)
        return out
    }

    /** Was that worked out today? If not it is worth asking again. */
    fun lastTimesDay(ctx: Context): String = prefs(ctx).getString(KEY_LASTS_DAY, "").orEmpty()

    fun putLastTimes(ctx: Context, day: String, lines: Map<String, String>) {
        val o = JSONObject()
        lines.forEach { (key, line) -> o.put(key, line) }
        prefs(ctx).edit().putString(KEY_LASTS, o.toString()).putString(KEY_LASTS_DAY, day).apply()
    }

    // ── A timer that outlives the screen ─────────────────────────────────

    /**
     * The rest running right now, so raising your wrist again shows the count
     * still going rather than a blank app that lost it.
     */
    data class Timer(
        val label: String,
        val total: Int,
        val endsAt: Long,
        /**
         * Paused: what was left, held still, and [endsAt] is 0. A deadline
         * keeps moving closer while nobody is resting, so a paused rest has
         * none; resuming makes one again from this.
         */
        val pausedLeftMs: Long = 0L,
    ) {
        val paused: Boolean get() = pausedLeftMs > 0L
    }

    fun timer(ctx: Context): Timer? {
        val raw = prefs(ctx).getString(KEY_TIMER, null) ?: return null
        val o = runCatching { JSONObject(raw) }.getOrNull() ?: return null
        val left = o.optLong("pausedLeftMs", 0L)
        if (left > 0L) return Timer(o.optString("label"), o.optInt("total", 0), 0L, left)
        val endsAt = o.optLong("endsAt", 0L)
        if (endsAt <= 0L) return null
        return Timer(o.optString("label"), o.optInt("total", 0), endsAt)
    }

    fun putTimer(ctx: Context, timer: Timer) {
        val o = JSONObject().put("label", timer.label).put("total", timer.total).put("endsAt", timer.endsAt)
        if (timer.paused) o.put("pausedLeftMs", timer.pausedLeftMs)
        prefs(ctx).edit().putString(KEY_TIMER, o.toString()).apply()
    }

    /**
     * What a /lifttrace/rest record from the phone means: a rest counting to
     * a deadline, one paused with time left, or none (null).
     *
     * A paused rest arrives as cleared with paused beside it. A phone from
     * before pausing never sends paused, so its records read exactly as they
     * always did; and a watch from before pausing reads a paused rest as
     * cleared, taking it down instead of buzzing in the middle of a pause.
     */
    fun restFrom(
        cleared: Boolean,
        paused: Boolean,
        leftMs: Long,
        label: String,
        total: Int,
        endsAt: Long,
        now: Long,
    ): Timer? {
        if (paused) {
            if (leftMs <= 0L) return null
            return Timer(label, if (total > 0) total else ((leftMs + 999) / 1000).toInt(), 0L, leftMs)
        }
        if (cleared || endsAt <= now) return null
        return Timer(label, total, endsAt)
    }

    /**
     * "I am here", said by the watch whenever its app is opened.
     *
     * The phone only sends a rest over when this is recent. A rest set on the
     * phone has no business waking a watch in a drawer, let alone buzzing it,
     * and the phone cannot otherwise tell the difference between a watch on a
     * wrist and one on a charger in another room.
     */
    fun publishAwake(ctx: Context) {
        val request = PutDataMapRequest.create(PairingService.AWAKE_PATH)
        request.dataMap.putLong("at", System.currentTimeMillis())
        runCatching {
            Wearable.getDataClient(ctx).putDataItem(request.asPutDataRequest().setUrgent())
        }.onFailure { Log.w(TAG, "couldn't say hello to the phone: " + it.message) }
    }

    /** The wearer started, extended, paused, resumed or skipped a rest. Tell the phone. */
    fun publishRest(ctx: Context, timer: Timer?) {
        val at = System.currentTimeMillis()
        prefs(ctx).edit().putLong(KEY_REST_AT, at).apply()
        val request = PutDataMapRequest.create(PairingService.REST_PATH)
        request.dataMap.apply {
            if (timer != null && timer.paused) {
                // Cleared, to a phone from before pausing: it stops its rest
                // rather than ringing at a deadline that no longer exists.
                putBoolean("cleared", true)
                putBoolean("paused", true)
                putLong("leftMs", timer.pausedLeftMs)
                putString("label", timer.label)
                putInt("total", timer.total)
                putLong("endsAt", 0L)
            } else if (timer == null || timer.endsAt <= at) {
                putBoolean("cleared", true)
                putBoolean("paused", false)
            } else {
                putBoolean("cleared", false)
                putBoolean("paused", false)
                putString("label", timer.label)
                putInt("total", timer.total)
                putLong("endsAt", timer.endsAt)
            }
            putLong("at", at)
        }
        runCatching {
            Wearable.getDataClient(ctx).putDataItem(request.asPutDataRequest().setUrgent())
        }.onFailure { Log.w(TAG, "couldn't tell the phone about the rest: " + it.message) }
    }

    /**
     * A rest started on the phone. The later word wins, as everywhere else,
     * and the alarm is made to match so the buzz happens with the app long
     * gone from the screen.
     */
    fun adoptRest(ctx: Context, map: DataMap) {
        val at = map.getLong("at", 0L)
        if (at > 0 && at < prefs(ctx).getLong(KEY_REST_AT, 0L)) return
        val now = System.currentTimeMillis()
        val rest = restFrom(
            cleared = map.getBoolean("cleared", false),
            paused = map.getBoolean("paused", false),
            leftMs = map.getLong("leftMs", 0L),
            label = map.getString("label").orEmpty(),
            total = map.getInt("total", 0),
            endsAt = map.getLong("endsAt", 0L),
            now = now,
        )
        when {
            // A hold counting here is published as a rest, but it is a set
            // being held: it logs itself at zero and is not paused from afar.
            rest != null && rest.paused && holdArmed(ctx) -> return
            rest == null -> {
                RestAlarm.cancel(ctx)
                clearTimer(ctx)
                RestOngoing.hide(ctx)
            }
            rest.paused -> {
                // Held: no buzz until it is resumed, and the count on the
                // face stops where it is.
                RestAlarm.cancel(ctx)
                putTimer(ctx, rest)
                RestOngoing.refresh(ctx)
            }
            else -> {
                putTimer(ctx, rest)
                RestAlarm.schedule(ctx, rest.endsAt)
                RestOngoing.refresh(ctx)
            }
        }
        prefs(ctx).edit().putLong(KEY_REST_AT, if (at > 0) at else now).apply()
    }

    fun clearTimer(ctx: Context) {
        prefs(ctx).edit().remove(KEY_TIMER).apply()
    }

    // ── A hold that logs itself ──────────────────────────────────────────

    /**
     * The set a running hold belongs to. A plank is done with your wrist on
     * the floor and the watch back on its face, so the hold cannot depend on
     * anyone watching it finish: it is written down here when it starts, and
     * whatever gets there first, the app or the alarm, logs it.
     */
    fun armHold(ctx: Context, op: Op) {
        prefs(ctx).edit().putString(KEY_HOLD, op.toJson().toString()).apply()
    }

    fun clearHold(ctx: Context) {
        prefs(ctx).edit().remove(KEY_HOLD).apply()
    }

    /** Is a hold still counting toward logging itself? */
    fun holdArmed(ctx: Context): Boolean = prefs(ctx).contains(KEY_HOLD)

    /**
     * The hold is over: mark its set done in what the watch is showing and put
     * it on the queue. Safe to call twice, since the queue keeps one entry per
     * set and the change says what the set reads rather than nudging it.
     */
    fun completeHold(ctx: Context): Boolean {
        val raw = prefs(ctx).getString(KEY_HOLD, null) ?: return false
        val op = runCatching { Op.from(JSONObject(raw)) }.getOrNull() ?: run {
            clearHold(ctx)
            return false
        }
        val change = op.change ?: run {
            clearHold(ctx)
            return false
        }
        // A hold that was the last set finishes the workout, as ticking the
        // last set does anywhere else, with the app open or not.
        var finishing: Session.Workout? = null
        cache(ctx)?.let { body ->
            runCatching {
                val workout = Session.parse(body) ?: return@runCatching
                val after = Session.applyChange(workout, change)
                putCache(ctx, JSONObject().put("workout", after.raw).toString())
                if (workout.id == op.workoutId && workout.date == op.date && Session.finishes(workout, change)) {
                    finishing = after
                }
            }
        }
        queue(ctx, op)
        finishing?.let { finish(ctx, it) }
        // Last: clearing it tells an open app to catch up and send (it hears
        // at once, on this thread), and by then the finish is queued too.
        clearHold(ctx)
        return true
    }

    // ── Finishing ────────────────────────────────────────────────────────

    /**
     * The workout is over, said on the wrist: what the phone does when you
     * finish there (Diary.svelte finishWorkout), as far as a watch can.
     *
     * The length comes off the shared clock, which stops, and any rest stops
     * on both devices. The end is queued like a set, so it holds with no
     * signal and goes up with whatever else is waiting, and the summary is
     * noted to be shown, so a workout finished by a hold with the app closed
     * still shows it when the app is opened. The notification and the
     * calories sent to NutriTrace are the server's to do once this arrives
     * (server/lib/watch-finish.js).
     *
     * Returns the workout as finished, or null when it already was: that
     * isn't finished, or celebrated, a second time.
     */
    fun finish(ctx: Context, workout: Session.Workout, now: Long = System.currentTimeMillis()): Session.Workout? {
        if (workout.completed) return null
        val date = workout.date.ifBlank { java.time.LocalDate.now().toString() }
        val clock = session(ctx)?.takeIf { it.date == date }
        val minutes = clock?.minutes(now)
        // Queued and written down before anything else changes: an open app
        // hears each change below as it's made, and reads and sends what's
        // here when it does.
        queue(ctx, Op(date, workout.id, minutes = minutes, finished = true))
        val done = Session.finish(workout, minutes)
        putCache(ctx, JSONObject().put("workout", done.raw).toString())
        prefs(ctx).edit().putString(KEY_FINISHED, "$date|${workout.id}").apply()
        if (clock != null) publishSession(ctx, null)
        if (timer(ctx) != null) stopRest(ctx)
        return done
    }

    /** The finished workout whose summary is waiting to be seen, if it's this one. */
    fun finishedUnseen(ctx: Context, workout: Session.Workout?): Boolean {
        val w = workout ?: return false
        return prefs(ctx).getString(KEY_FINISHED, null) == "${w.date}|${w.id}"
    }

    fun clearFinished(ctx: Context) {
        prefs(ctx).edit().remove(KEY_FINISHED).apply()
    }

    /**
     * The rest is over because the workout is: the alarm, the entry on the
     * watch face and the phone's copy all go, and a hold that was counting
     * won't log itself later.
     */
    fun stopRest(ctx: Context) {
        RestAlarm.cancel(ctx)
        clearTimer(ctx)
        RestOngoing.hide(ctx)
        publishRest(ctx, null)
        clearHold(ctx)
    }

    // ── Changes made with no connection ──────────────────────────────────

    /**
     * One set the watch changed, waiting to be sent. What is kept is the set
     * as the watch now says it reads, so it can be replayed onto whatever the
     * server holds by the time there is a connection rather than sending a
     * stale copy of the whole day over the top of it.
     */
    data class Op(
        val date: String,
        val workoutId: Long,
        /** A set, as the watch now says it reads. */
        val change: Session.Change? = null,
        /** Or how long the session ran, when the timer was stopped here. */
        val minutes: Double? = null,
        /** Or that the session is over, when it was finished here. */
        val finished: Boolean = false,
        /**
         * Which entry this is, counting up. A send only removes the entries it
         * actually sent: something logged while the sending was still in the
         * air is a different entry and stays for the next one, rather than
         * being tidied away with the batch it was never part of.
         */
        val seq: Long = 0,
    ) {
        /** One entry per set, one for the session's length, one for the end. */
        val key: String get() = change?.setUuid ?: if (finished) "finished" else "duration"

        fun toJson(): JSONObject {
            val o = JSONObject().put("date", date).put("workoutId", workoutId).put("seq", seq)
            if (finished) return o.put("finished", true).put("minutes", minutes ?: JSONObject.NULL)
            if (minutes != null) return o.put("minutes", minutes)
            val c = change ?: return o
            return o
                .put("exerciseUuid", c.exerciseUuid).put("setUuid", c.setUuid)
                .put("weight", c.weight).put("reps", c.reps)
                .put("repsLeft", c.repsLeft ?: JSONObject.NULL)
                .put("repsRight", c.repsRight ?: JSONObject.NULL)
                .put("durationSec", c.durationSec)
                .put("completed", c.completed).put("warmup", c.warmup)
        }

        companion object {
            fun from(o: JSONObject): Op {
                if (o.optBoolean("finished", false)) {
                    return Op(
                        o.optString("date"), o.optLong("workoutId"),
                        minutes = if (o.isNull("minutes")) null else o.optDouble("minutes", 0.0),
                        finished = true, seq = o.optLong("seq", 0L),
                    )
                }
                if (o.has("minutes")) {
                    return Op(
                        o.optString("date"), o.optLong("workoutId"),
                        minutes = o.optDouble("minutes", 0.0), seq = o.optLong("seq", 0L),
                    )
                }
                return Op(
                    date = o.optString("date"),
                    workoutId = o.optLong("workoutId"),
                    seq = o.optLong("seq", 0L),
                    change = Session.Change(
                        exerciseUuid = o.optString("exerciseUuid"),
                        setUuid = o.optString("setUuid"),
                        weight = o.optDouble("weight", 0.0),
                        reps = o.optInt("reps", 0),
                        repsLeft = if (o.isNull("repsLeft")) null else o.optInt("repsLeft", 0),
                        repsRight = if (o.isNull("repsRight")) null else o.optInt("repsRight", 0),
                        durationSec = o.optInt("durationSec", 0),
                        completed = o.optBoolean("completed", false),
                        warmup = o.optBoolean("warmup", false),
                    ),
                )
            }
        }
    }

    /**
     * The session's own fields a batch changes, for X-Changed-Fields: the
     * server keeps its own copy of every other one (server/lib/newer-wins.js),
     * so the name, notes and the rest, sent back only because they were in
     * the day the watch read, can't overwrite a newer edit made on the phone.
     */
    /**
     * What's waiting laid over the server's copy of the day, for the screen:
     * the sets, the length when the clock was stopped, and the finish. A send
     * the server refused leaves them queued, and the workout must not look
     * unfinished meanwhile, or Finish Workout would come back for a workout
     * already finished here.
     */
    fun replay(workout: Session.Workout, ops: List<Op>): Session.Workout = ops.fold(workout) { acc, op ->
        val change = op.change
        when {
            change != null -> Session.applyChange(acc, change)
            op.finished -> Session.finish(acc, op.minutes)
            op.minutes != null -> acc.copy(raw = JSONObject(acc.raw.toString()).put("duration_min", op.minutes))
            else -> acc
        }
    }

    fun changedFields(batch: List<Op>): List<String> = buildList {
        if (batch.any { it.finished }) add("completed")
        if (batch.any { it.minutes != null }) add("duration_min")
    }

    fun outbox(ctx: Context): List<Op> {
        val raw = prefs(ctx).getString(KEY_OUTBOX, null) ?: return emptyList()
        val arr = runCatching { JSONArray(raw) }.getOrNull() ?: return emptyList()
        return (0 until arr.length()).mapNotNull { runCatching { Op.from(arr.getJSONObject(it)) }.getOrNull() }
    }

    fun queue(ctx: Context, op: Op) {
        // One entry per set: changing the same set twice is a correction, not
        // a second set, and the last word wins. The new entry goes at the end
        // so the order changes were made in is the order they are replayed in,
        // and carries its own number so a send in flight cannot tidy it away.
        val next = prefs(ctx).getLong(KEY_SEQ, 0L) + 1
        prefs(ctx).edit().putLong(KEY_SEQ, next).apply()
        val kept = outbox(ctx).filterNot { it.key == op.key && it.date == op.date }
        writeOutbox(ctx, kept + op.copy(seq = next))
    }

    fun writeOutbox(ctx: Context, ops: List<Op>) {
        val arr = JSONArray()
        ops.forEach { arr.put(it.toJson()) }
        prefs(ctx).edit().putString(KEY_OUTBOX, arr.toString()).apply()
    }
}
