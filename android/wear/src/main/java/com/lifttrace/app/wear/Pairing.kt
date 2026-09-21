package com.lifttrace.app.wear

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import com.google.android.gms.wearable.DataMapItem
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
    private const val KEY_URL = "server_url"
    private const val KEY_TOKEN = "token"
    private const val KEY_CACHE = "cache"
    private const val KEY_CACHE_AT = "cache_at"
    private const val KEY_SETTINGS = "settings"
    private const val KEY_OUTBOX = "outbox"
    private const val KEY_TIMER = "timer"
    private const val KEY_REFUSED = "refused_token"

    private fun prefs(ctx: Context): SharedPreferences =
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

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
            .remove(KEY_CACHE).remove(KEY_SETTINGS).remove(KEY_OUTBOX).remove(KEY_TIMER).apply()
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

    fun putSettings(ctx: Context, settings: JSONObject) {
        prefs(ctx).edit().putString(KEY_SETTINGS, settings.toString()).apply()
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
        val change: Session.Change,
    ) {
        fun toJson(): JSONObject = JSONObject()
            .put("date", date).put("workoutId", workoutId)
            .put("exerciseUuid", change.exerciseUuid).put("setUuid", change.setUuid)
            .put("weight", change.weight).put("reps", change.reps)
            .put("repsLeft", change.repsLeft ?: JSONObject.NULL)
            .put("repsRight", change.repsRight ?: JSONObject.NULL)
            .put("durationSec", change.durationSec)
            .put("completed", change.completed).put("warmup", change.warmup)

        companion object {
            fun from(o: JSONObject) = Op(
                date = o.optString("date"),
                workoutId = o.optLong("workoutId"),
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

    fun outbox(ctx: Context): List<Op> {
        val raw = prefs(ctx).getString(KEY_OUTBOX, null) ?: return emptyList()
        val arr = runCatching { JSONArray(raw) }.getOrNull() ?: return emptyList()
        return (0 until arr.length()).mapNotNull { runCatching { Op.from(arr.getJSONObject(it)) }.getOrNull() }
    }

    fun queue(ctx: Context, op: Op) {
        // One entry per set: changing the same set twice is a correction, not
        // a second set, and the last word wins. The new entry goes at the end
        // so the order changes were made in is the order they are replayed in.
        val kept = outbox(ctx).filterNot { it.change.setUuid == op.change.setUuid && it.date == op.date }
        writeOutbox(ctx, kept + op)
    }

    fun writeOutbox(ctx: Context, ops: List<Op>) {
        val arr = JSONArray()
        ops.forEach { arr.put(it.toJson()) }
        prefs(ctx).edit().putString(KEY_OUTBOX, arr.toString()).apply()
    }
}
