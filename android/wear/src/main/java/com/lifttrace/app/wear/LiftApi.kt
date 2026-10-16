package com.lifttrace.app.wear

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * The watch talking to a LiftTrace server: today's session, the settings that
 * decide how long to rest, and the day sent back when a set is logged.
 *
 * Deliberately small. The watch reads one day and writes one day, the same
 * way the phone and the browser do, so the merge on the server is the one
 * already in use and nothing new has to be kept in step.
 */
object LiftApi {

    class ApiError(message: String, val code: Int) : Exception(message)

    private val JSON = "application/json; charset=utf-8".toMediaType()

    private val client = OkHttpClient.Builder()
        // A watch on a gym's wifi is slow, not broken; a phone in a locker is
        // gone. These are long enough for the first and short enough that the
        // second doesn't leave the screen spinning.
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .build()

    /**
     * The day's session, as the server has it. The id is passed on whenever
     * the watch knows it, so a date holding more than one session keeps
     * answering with the one the watch is actually in.
     */
    suspend fun workout(cfg: Pairing.Config, date: String, id: Long = 0L): String =
        get(cfg, "/api/workout/$date" + if (id > 0) "?id=$id" else "")

    /**
     * The last few sessions, for what you did of each exercise last time. One
     * request covers every exercise in today's session.
     */
    suspend fun recent(cfg: Pairing.Config, limit: Int = 20): String =
        get(cfg, "/api/workout/recent?limit=$limit")

    /** Rest length, whether it starts by itself, and the weight unit. */
    suspend fun settings(cfg: Pairing.Config): JSONObject =
        runCatching { JSONObject(get(cfg, "/api/settings")) }.getOrDefault(JSONObject())

    /** The whole day back, with the set just logged marked done. */
    suspend fun saveWorkout(cfg: Pairing.Config, date: String, body: JSONObject): String =
        send(cfg, "PUT", "/api/workout/$date", body)

    private suspend fun get(cfg: Pairing.Config, path: String): String = send(cfg, "GET", path, null)

    private suspend fun send(cfg: Pairing.Config, method: String, path: String, body: JSONObject?): String =
        withContext(Dispatchers.IO) {
            val request = Request.Builder()
                .url(cfg.serverUrl.trimEnd('/') + path)
                .header("Authorization", "Bearer " + cfg.token)
                .header("Accept", "application/json")
                .method(method, body?.toString()?.toRequestBody(JSON))
                .build()
            client.newCall(request).execute().use { res ->
                val text = res.body?.string().orEmpty()
                if (!res.isSuccessful) {
                    val message = runCatching { JSONObject(text).optString("error") }.getOrNull()
                    throw ApiError(message?.ifBlank { "Server error " + res.code } ?: ("Server error " + res.code), res.code)
                }
                text
            }
        }
}
