package com.lifttrace.app.wear

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
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
    private const val KEY_HOLD = "pending_hold"
    private const val KEY_TIMER = "timer"
    const val KEY_SESSION = "session_timer"
    private const val KEY_LASTS = "last_times"
    private const val KEY_LASTS_DAY = "last_times_day"
    private const val KEY_REFUSED = "refused_token"

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

    fun save(ctx: Context, serverUrl: String, token: String) {
        prefs(ctx).edit()
            .putString(KEY_URL, serverUrl.trim().trimEnd('/'))
            .putString(KEY_TOKEN, token.trim())
            // A fresh token: whatever was refused before is history.
            .remove(KEY_REFUSED)
            .apply()
    }

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
            .remove(KEY_LASTS).remove(KEY_LASTS_DAY).remove(KEY_SESSION).apply()
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
        return SessionTimer(
            date = date,
            startTime = o.optLong("startTime", 0L),
            baseElapsedSec = o.optDouble("baseElapsed", 0.0),
            paused = o.optBoolean("paused", false),
            pausedElapsedSec = o.optDouble("pausedElapsed", 0.0),
        )
    }

    fun putSession(ctx: Context, map: com.google.android.gms.wearable.DataMap) {
        if (map.getBoolean("cleared", false)) {
            clearSession(ctx)
            return
        }
        val o = JSONObject()
            .put("date", map.getString("date").orEmpty())
            .put("startTime", map.getLong("startTime"))
            .put("baseElapsed", map.getDouble("baseElapsed"))
            .put("paused", map.getBoolean("paused"))
            .put("pausedElapsed", map.getDouble("pausedElapsed"))
        prefs(ctx).edit().putString(KEY_SESSION, o.toString()).apply()
    }

    fun clearSession(ctx: Context) {
        prefs(ctx).edit().remove(KEY_SESSION).apply()
    }

    /**
     * The wearer started, paused or stopped the timer. It is written down here
     * and told to the phone, which is what writes the session's length onto
     * the day when the workout is finished there.
     */
    fun publishSession(ctx: Context, timer: SessionTimer?) {
        if (timer == null) clearSession(ctx) else putSession(ctx, timer)
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
            putLong("at", System.currentTimeMillis())
        }
        runCatching {
            Wearable.getDataClient(ctx).putDataItem(request.asPutDataRequest().setUrgent())
        }.onFailure { Log.w(TAG, "couldn't tell the phone about the timer: " + it.message) }
    }

    private fun putSession(ctx: Context, timer: SessionTimer) {
        val o = JSONObject()
            .put("date", timer.date)
            .put("startTime", timer.startTime)
            .put("baseElapsed", timer.baseElapsedSec)
            .put("paused", timer.paused)
            .put("pausedElapsed", timer.pausedElapsedSec)
        prefs(ctx).edit().putString(KEY_SESSION, o.toString()).apply()
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
    data class Timer(val label: String, val total: Int, val endsAt: Long)

    fun timer(ctx: Context): Timer? {
        val raw = prefs(ctx).getString(KEY_TIMER, null) ?: return null
        val o = runCatching { JSONObject(raw) }.getOrNull() ?: return null
        val endsAt = o.optLong("endsAt", 0L)
        if (endsAt <= 0L) return null
        return Timer(o.optString("label"), o.optInt("total", 0), endsAt)
    }

    fun putTimer(ctx: Context, timer: Timer) {
        val o = JSONObject().put("label", timer.label).put("total", timer.total).put("endsAt", timer.endsAt)
        prefs(ctx).edit().putString(KEY_TIMER, o.toString()).apply()
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
        cache(ctx)?.let { body ->
            runCatching {
                val workout = Session.parse(body) ?: return@runCatching
                putCache(ctx, JSONObject().put("workout", Session.applyChange(workout, change).raw).toString())
            }
        }
        queue(ctx, op)
        clearHold(ctx)
        return true
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
        /**
         * Which entry this is, counting up. A send only removes the entries it
         * actually sent: something logged while the sending was still in the
         * air is a different entry and stays for the next one, rather than
         * being tidied away with the batch it was never part of.
         */
        val seq: Long = 0,
    ) {
        /** One entry per set, and one for the session's length. */
        val key: String get() = change?.setUuid ?: "duration"

        fun toJson(): JSONObject {
            val o = JSONObject().put("date", date).put("workoutId", workoutId).put("seq", seq)
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
