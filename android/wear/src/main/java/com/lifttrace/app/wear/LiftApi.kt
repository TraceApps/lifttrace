package com.lifttrace.app.wear

import android.content.Context
import com.google.android.gms.wearable.Wearable
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withContext
import okhttp3.ConnectionSpec
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
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

    /** Local mode: the phone couldn't answer (out of reach, or its app closed). The outbox keeps the set. */
    class PhoneUnavailable(message: String) : IOException(message)

    /** Where Local mode asks the phone (WearPairingPlugin.API_PATH). */
    private const val PHONE_API = "/lifttrace/api"

    private val JSON = "application/json; charset=utf-8".toMediaType()

    private val client = OkHttpClient.Builder()
        // A watch on a gym's wifi is slow, not broken; a phone in a locker is
        // gone. These are long enough for the first and short enough that the
        // second doesn't leave the screen spinning.
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        // https:// with no cleartext at all: a redirect to http:// fails, as
        // it did before the watch allowed cleartext (TraceApps/nutritrace#194).
        .connectionSpecs(listOf(ConnectionSpec.MODERN_TLS))
        .build()

    // Plain http:// to the confirmed server only, never following a redirect.
    private val plainClient = client.newBuilder()
        .connectionSpecs(listOf(ConnectionSpec.CLEARTEXT))
        .followRedirects(false)
        .followSslRedirects(false)
        .build()

    /**
     * The day's session, as the server has it. The id is passed on whenever
     * the watch knows it, so a date holding more than one session keeps
     * answering with the one the watch is actually in.
     */
    suspend fun workout(ctx: Context, cfg: Pairing.Config, date: String, id: Long = 0L): String =
        get(ctx, cfg, "/api/workout/$date" + if (id > 0) "?id=$id" else "")

    /**
     * The last few sessions, for what you did of each exercise last time. One
     * request covers every exercise in today's session.
     */
    suspend fun recent(ctx: Context, cfg: Pairing.Config, limit: Int = 20): String =
        get(ctx, cfg, "/api/workout/recent?limit=$limit")

    /** Rest length, whether it starts by itself, and the weight unit. */
    suspend fun settings(ctx: Context, cfg: Pairing.Config): JSONObject =
        runCatching { JSONObject(get(ctx, cfg, "/api/settings")) }.getOrDefault(JSONObject())

    /**
     * The whole day back, with the set just logged marked done. `changed`
     * names the session's own fields the watch changed (X-Changed-Fields):
     * the server keeps its copy of the others.
     */
    suspend fun saveWorkout(ctx: Context, cfg: Pairing.Config, date: String, body: JSONObject, changed: List<String>): String =
        send(ctx, cfg, "PUT", "/api/workout/$date", body, mapOf("X-Changed-Fields" to changed.joinToString(",")))

    private suspend fun get(ctx: Context, cfg: Pairing.Config, path: String): String = send(ctx, cfg, "GET", path, null)

    private suspend fun send(
        ctx: Context,
        cfg: Pairing.Config,
        method: String,
        path: String,
        body: JSONObject?,
        headers: Map<String, String> = emptyMap(),
    ): String =
        if (cfg.viaPhone) askPhone(ctx, method, path, body) else withContext(Dispatchers.IO) {
            // https:// as saved; plain http:// only to a server on your own
            // network that the phone confirmed (LocalAddress.workerBase).
            // Refused, it fails like no connection: the outbox keeps the set.
            // An https:// address goes as saved, as it always has, before the
            // parser below (which refuses international names) sees it.
            val base = (if (cfg.serverUrl.trim().startsWith("https://", ignoreCase = true)) cfg.serverUrl.trim() else null)
                ?: LocalAddress.workerBase(cfg.serverUrl, cfg.httpOk)
                ?: throw IOException("plain HTTP to this server isn't confirmed on the phone")
            val plain = base.startsWith("http:")
            val builder = Request.Builder()
                .url(base.trimEnd('/') + path)
                .header("Authorization", "Bearer " + cfg.token)
                .header("Accept", "application/json")
            headers.forEach { (name, value) -> builder.header(name, value) }
            val request = builder
                .method(method, body?.toString()?.toRequestBody(JSON))
                .build()
            (if (plain) plainClient else client).newCall(request).execute().use { res ->
                val text = res.body?.string().orEmpty()
                if (!res.isSuccessful) {
                    val message = runCatching { JSONObject(text).optString("error") }.getOrNull()
                    throw ApiError(message?.ifBlank { "Server error " + res.code } ?: ("Server error " + res.code), res.code)
                }
                text
            }
        }

    /**
     * Local mode (#156): the same request, answered by the phone's app over
     * the Wear connection instead of by a server. A failure here is like no
     * connection: the outbox keeps the set and says why.
     */
    private suspend fun askPhone(ctx: Context, method: String, path: String, body: JSONObject?): String {
        val nodes = try {
            Wearable.getNodeClient(ctx).connectedNodes.await()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            throw PhoneUnavailable("Phone not nearby")
        }
        val phone = nodes.firstOrNull { it.isNearby } ?: nodes.firstOrNull() ?: throw PhoneUnavailable("Phone not nearby")
        val request = JSONObject().put("method", method).put("path", path).put("body", body?.toString() ?: JSONObject.NULL)
        val answer = try {
            withTimeout(25_000) {
                Wearable.getMessageClient(ctx).sendRequest(phone.id, PHONE_API, request.toString().toByteArray(Charsets.UTF_8)).await()
            }
        } catch (e: TimeoutCancellationException) {
            throw PhoneUnavailable("Open LiftTrace on your phone")
        } catch (e: CancellationException) {
            // The screen closed: nothing to say.
            throw e
        } catch (e: Exception) {
            // No one listening on the phone: its app isn't running.
            throw PhoneUnavailable("Open LiftTrace on your phone")
        }
        return readPhoneAnswer(answer)
    }

    /** The phone's reply ({status, body}, WearPairingPlugin.reply): the body, or why not. */
    fun readPhoneAnswer(answer: ByteArray): String {
        val reply = runCatching { JSONObject(String(answer, Charsets.UTF_8)) }.getOrNull()
            ?: throw PhoneUnavailable("Open LiftTrace on your phone")
        val status = reply.optInt("status", 500)
        val text = reply.optString("body", "")
        // The app not ready yet, or too slow: it keeps the set, as offline.
        if (status == 503 || status == 504) throw PhoneUnavailable("Open LiftTrace on your phone")
        if (status !in 200..299) {
            val message = runCatching { JSONObject(text).optString("error") }.getOrNull()
            throw ApiError(message?.ifBlank { "Phone error $status" } ?: "Phone error $status", status)
        }
        return text
    }
}
