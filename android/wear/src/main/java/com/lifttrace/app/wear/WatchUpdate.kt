package com.lifttrace.app.wear

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.ConnectionSpec
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

/**
 * The watch keeps up with the phone. Installed from GitHub (not the Play
 * Store, which updates it itself), the watch app used to stay on whatever
 * release it was put on with adb while the phone updated itself. Now the
 * phone says which release it runs whenever it pairs, and a watch on an older
 * one fetches the watch build of that same release from GitHub and installs
 * it. Following the phone's release, rather than checking GitHub on its own,
 * keeps the two on the same version and needs no channel setting.
 *
 * When it installs: Android closes an app it updates, and a watch app is off
 * screen most of the time it's in use (between sets, while something cooks),
 * so an update that needs no tap waits for the watch to be on its charger.
 * One that needs a tap is offered when the app is opened, since only then
 * can its question show; declined, it isn't offered again for a while.
 */
object WatchUpdate {
    private const val TAG = "LiftTraceUpdate"
    private const val CHANNEL = "updates"
    private const val NOTE_ID = 7301
    private const val PREFS = "lifttrace.update"
    private const val KEY_PROMPTED = "prompted_"
    private const val KEY_DECLINED = "declined_"
    private const val KEY_FAILED = "failed_"
    private const val KEY_SESSION = "session"
    private const val HOUR = 60 * 60 * 1000L
    /** A reminder after a notification left alone, at most this often. */
    private const val PROMPT_EVERY_MS = 6 * HOUR
    /** Declined on the install screen: not offered again for this long. */
    private const val DECLINED_FOR_MS = 12 * HOUR
    /** Back from allowing installs within this long counts as a yes. */
    private const val JUST_ALLOWED_MS = 10 * 60 * 1000L
    /** No build to fetch, or it wouldn't install: not tried again for this long. */
    private const val FAILED_FOR_MS = 6 * HOUR
    /** Debug builds only: where to look instead of GitHub, for testing. */
    const val KEY_API = "api_override"

    /** Is the app on screen? Set by the activity as it comes and goes. */
    @Volatile var onScreen = false

    // GitHub only ever, so HTTPS only: no cleartext at all, a redirect to
    // http:// included. The watch allows cleartext for a confirmed server on
    // your own network (TraceApps/nutritrace#194), never for this.
    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .connectionSpecs(listOf(ConnectionSpec.MODERN_TLS))
        .build()

    // ── Deciding ──────────────────────────────────────────────────────────

    /** Installed by the Play Store, which keeps it up to date itself. */
    fun fromPlay(ctx: Context): Boolean = runCatching {
        ctx.packageManager.getInstallSourceInfo(ctx.packageName).installingPackageName == "com.android.vending"
    }.getOrDefault(false)

    /**
     * Compare two release tags (v1.4.0, v1.4.0-dev05) as the phone's updater
     * does (src/lib/updates.js compareSemver): a release outranks any of its
     * own pre-releases. 1 when [a] is newer, -1 when older, 0 when the same or
     * unreadable.
     */
    fun compare(a: String, b: String): Int {
        val pa = parse(a) ?: return 0
        val pb = parse(b) ?: return 0
        for (i in 0..2) if (pa.first[i] != pb.first[i]) return pa.first[i].compareTo(pb.first[i])
        val xa = pa.second
        val xb = pb.second
        if (xa.isEmpty() && xb.isEmpty()) return 0
        if (xa.isEmpty()) return 1
        if (xb.isEmpty()) return -1
        for (i in 0 until maxOf(xa.size, xb.size)) {
            if (i >= xa.size) return -1
            if (i >= xb.size) return 1
            val na = xa[i].toLongOrNull()
            val nb = xb[i].toLongOrNull()
            val c = when {
                na != null && nb != null -> na.compareTo(nb)
                na != null -> -1
                nb != null -> 1
                else -> xa[i].compareTo(xb[i])
            }
            if (c != 0) return c.coerceIn(-1, 1)
        }
        return 0
    }

    private fun parse(tag: String): Pair<List<Int>, List<String>>? {
        val m = Regex("""^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?""").find(tag.trim()) ?: return null
        val base = (1..3).map { m.groupValues[it].toInt() }
        val pre = m.groupValues[4].takeIf { it.isNotEmpty() }?.split('.') ?: emptyList()
        return base to pre
    }

    /** The watch build's file name in a release, as the release puts it there. */
    fun assetName(tag: String): String = "${BuildConfig.APP_SLUG}-wear-$tag.apk"

    /** Is there a newer release to catch up to, and is it this app's to fetch? */
    private fun wanted(ctx: Context, tag: String): Boolean =
        !fromPlay(ctx) && compare(tag, BuildConfig.RELEASE) > 0

    private fun within(ctx: Context, key: String, ms: Long): Boolean =
        System.currentTimeMillis() - prefs(ctx).getLong(key, 0L) < ms

    /**
     * The phone runs a newer release: fetch it. [onScreen]: the app was just
     * opened, so an update waiting for a tap is offered now rather than at
     * the next reminder (unless it was just declined).
     */
    fun check(ctx: Context, onScreen: Boolean = false) {
        val target = Pairing.phoneRelease(ctx) ?: return
        clean(ctx)
        if (!wanted(ctx, target)) return
        if (within(ctx, KEY_FAILED + target, FAILED_FOR_MS)) return
        // Left the install screen to allow installs, and back: that was a yes,
        // so it installs now rather than waiting for the charger.
        val justAllowed = onScreen && silentPossible(ctx) && within(ctx, KEY_DECLINED + target, JUST_ALLOWED_MS)
        if (justAllowed) prefs(ctx).edit().remove(KEY_DECLINED + target).apply()
        else if (within(ctx, KEY_DECLINED + target, DECLINED_FOR_MS)) return
        if (!onScreen && within(ctx, KEY_PROMPTED + target, PROMPT_EVERY_MS)) return
        val work = OneTimeWorkRequestBuilder<UpdateWorker>()
            .setInputData(workDataOf("tag" to target, "now" to justAllowed))
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build()
        // One at a time: asked again while it runs, the running one carries on.
        WorkManager.getInstance(ctx).enqueueUniqueWork("watch-update", ExistingWorkPolicy.KEEP, work)
    }

    /** Stays wanted? Checked again by the work itself, which can outlive an update. */
    fun stillWanted(ctx: Context, tag: String): Boolean {
        clean(ctx)
        return wanted(ctx, tag)
    }

    fun failed(ctx: Context, tag: String) {
        prefs(ctx).edit().putLong(KEY_FAILED + tag, System.currentTimeMillis()).apply()
    }

    fun declined(ctx: Context, tag: String) {
        prefs(ctx).edit().putLong(KEY_DECLINED + tag, System.currentTimeMillis()).apply()
    }

    // ── Fetching ──────────────────────────────────────────────────────────

    private fun apiBase(ctx: Context): String =
        if (BuildConfig.DEBUG) prefs(ctx).getString(KEY_API, null)?.takeIf { it.isNotBlank() } ?: BuildConfig.UPDATE_API
        else BuildConfig.UPDATE_API

    /** The release's watch build: its address, size and checksum. */
    private data class Asset(val url: String, val size: Long, val sha256: String?)

    /** The watch build attached to release [tag], or null when there is none. */
    private fun asset(ctx: Context, tag: String): Asset? {
        val req = Request.Builder()
            .url(apiBase(ctx).trimEnd('/') + "/releases/tags/" + tag)
            .header("Accept", "application/vnd.github+json")
            .header("User-Agent", "TraceApps-LiftTrace-Wear/" + BuildConfig.RELEASE)
            .build()
        val body = http.newCall(req).execute().use { res ->
            if (res.code == 404) return null
            if (!res.isSuccessful) throw IOException("release lookup " + res.code)
            res.body?.string()
        } ?: return null
        val assets = JSONObject(body).optJSONArray("assets") ?: return null
        for (i in 0 until assets.length()) {
            val a = assets.optJSONObject(i) ?: continue
            if (a.optString("name") != assetName(tag)) continue
            val digest = a.optString("digest").removePrefix("sha256:").lowercase().takeIf { it.length == 64 }
            return Asset(a.optString("browser_download_url"), a.optLong("size"), digest)
        }
        return null
    }

    /**
     * The watch build of [tag], downloaded and checked. One already here and
     * whole is used as it is: leaving the install prompt and coming back must
     * not mean downloading it all again.
     */
    suspend fun download(ctx: Context, tag: String): File? = withContext(Dispatchers.IO) {
        val asset = asset(ctx, tag) ?: return@withContext null
        val dir = File(ctx.filesDir, "updates").apply { mkdirs() }
        val file = File(dir, assetName(tag))
        if (whole(file, asset)) return@withContext file
        dir.listFiles()?.forEach { if (it.name != file.name) it.delete() }
        val part = File(dir, file.name + ".part")
        val req = Request.Builder().url(asset.url).header("User-Agent", "TraceApps-LiftTrace-Wear/" + BuildConfig.RELEASE).build()
        http.newCall(req).execute().use { res ->
            if (!res.isSuccessful) throw IOException("download " + res.code)
            val src = res.body ?: throw IOException("empty download")
            part.outputStream().use { out -> src.byteStream().use { it.copyTo(out) } }
        }
        if (!whole(part, asset)) {
            part.delete()
            throw IOException("download incomplete or damaged")
        }
        part.renameTo(file)
        file
    }

    private fun whole(f: File, asset: Asset): Boolean =
        f.exists() && f.length() == asset.size && (asset.sha256 == null || sha256(f) == asset.sha256)

    private fun sha256(f: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        f.inputStream().use { input ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                md.update(buf, 0, n)
            }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    /** Builds of this release or older: installed already, or never wanted now. */
    fun clean(ctx: Context) {
        File(ctx.filesDir, "updates").listFiles()?.forEach { f ->
            val tag = Regex("""-wear-(v[^/]+?)\.apk(\.part)?$""").find(f.name)?.groupValues?.get(1)
            if (tag == null || compare(tag, BuildConfig.RELEASE) <= 0) f.delete()
        }
    }

    // ── Installing ────────────────────────────────────────────────────────

    /**
     * Can it install without asking? Allowed to install apps ("Install
     * unknown apps", granted once on the watch) and on Android 12 or later.
     */
    fun silentPossible(ctx: Context): Boolean =
        Build.VERSION.SDK_INT >= 31 && ctx.packageManager.canRequestPackageInstalls()

    /**
     * Downloaded: install it. One that installs without a tap waits for the
     * charger (InstallWorker), so it can't close the app in the middle of a
     * workout; one that has to ask goes ahead now, while it can be answered.
     */
    fun installOrWait(ctx: Context, apk: File, tag: String, now: Boolean = false) {
        if (silentPossible(ctx) && !now) {
            val work = OneTimeWorkRequestBuilder<InstallWorker>()
                .setInputData(workDataOf("tag" to tag))
                .setConstraints(Constraints.Builder().setRequiresCharging(true).build())
                .build()
            WorkManager.getInstance(ctx).enqueueUniqueWork("watch-install", ExistingWorkPolicy.REPLACE, work)
            return
        }
        install(ctx, apk, tag)
    }

    /** Hand the build to Android: installed silently where allowed, else asked. */
    fun install(ctx: Context, apk: File, tag: String) {
        val installer = ctx.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(ctx.packageName)
            if (Build.VERSION.SDK_INT >= 31) setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
        }
        // One unanswered request at a time: an earlier one, never confirmed,
        // goes before this one is made.
        val prev = prefs(ctx).getInt(KEY_SESSION, -1)
        if (prev >= 0) runCatching { installer.abandonSession(prev) }
        val id = installer.createSession(params)
        prefs(ctx).edit().putInt(KEY_SESSION, id).apply()
        installer.openSession(id).use { session ->
            session.openWrite("watch.apk", 0, apk.length()).use { out ->
                apk.inputStream().use { it.copyTo(out) }
                session.fsync(out)
            }
            val result = Intent(ctx, UpdateResultReceiver::class.java).putExtra("tag", tag)
            // Mutable: the installer adds the outcome to it.
            val pi = PendingIntent.getBroadcast(ctx, id, result, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE)
            session.commit(pi.intentSender)
        }
    }

    /**
     * Android wants a yes. On screen, its install screen opens at once; off
     * screen, a notification opens it. The notification needs a permission
     * the watch only grants once the app has asked for it, so opening the app
     * offers it again too (check, onScreen): the download is kept, so that
     * costs nothing.
     */
    fun confirm(ctx: Context, confirm: Intent, tag: String) {
        if (onScreen) {
            val shown = runCatching { ctx.startActivity(Intent(confirm).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }.isSuccess
            if (shown) return
        }
        askToInstall(ctx, confirm, tag)
    }

    private fun askToInstall(ctx: Context, confirm: Intent, tag: String) {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "Updates", NotificationManager.IMPORTANCE_DEFAULT))
        val open = PendingIntent.getActivity(
            ctx, NOTE_ID, confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val note = NotificationCompat.Builder(ctx, CHANNEL)
            .setSmallIcon(R.drawable.ic_refresh)
            .setContentTitle("Update ready")
            .setContentText("Tap to install LiftTrace " + tag.removePrefix("v"))
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()
        runCatching { nm.notify(NOTE_ID, note) }.onFailure { Log.w(TAG, "couldn't post the update: " + it.message) }
        prefs(ctx).edit().putLong(KEY_PROMPTED + tag, System.currentTimeMillis()).apply()
    }

    private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}

/** Downloads one release, when there is a connection, then installs it. */
class UpdateWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result {
        val tag = inputData.getString("tag") ?: return Result.failure()
        if (!WatchUpdate.stillWanted(applicationContext, tag)) return Result.success()
        return try {
            val apk = WatchUpdate.download(applicationContext, tag)
            if (apk == null) {
                Log.w("LiftTraceUpdate", "no watch build in release $tag")
                WatchUpdate.failed(applicationContext, tag)
                return Result.failure()
            }
            WatchUpdate.installOrWait(applicationContext, apk, tag, now = inputData.getBoolean("now", false))
            Result.success()
        } catch (e: IOException) {
            Log.w("LiftTraceUpdate", "update to $tag: " + e.message)
            if (runAttemptCount < 3) Result.retry() else Result.failure().also { WatchUpdate.failed(applicationContext, tag) }
        } catch (e: Exception) {
            Log.w("LiftTraceUpdate", "update to $tag failed: " + e.message)
            WatchUpdate.failed(applicationContext, tag)
            Result.failure()
        }
    }
}

/** Installs a downloaded release without a tap, on the charger and off screen. */
class InstallWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result {
        val tag = inputData.getString("tag") ?: return Result.failure()
        if (!WatchUpdate.stillWanted(applicationContext, tag)) return Result.success()
        // Charging with the app open: later, once it's been left.
        if (WatchUpdate.onScreen) return Result.retry()
        val apk = File(File(applicationContext.filesDir, "updates"), WatchUpdate.assetName(tag))
        if (!apk.exists()) return Result.failure()
        return try {
            WatchUpdate.install(applicationContext, apk, tag)
            Result.success()
        } catch (e: Exception) {
            Log.w("LiftTraceUpdate", "update to $tag failed: " + e.message)
            WatchUpdate.failed(applicationContext, tag)
            Result.failure()
        }
    }
}

/** What Android made of the install. */
class UpdateResultReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        val tag = intent.getStringExtra("tag").orEmpty()
        when (val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                val confirm = if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
                    else @Suppress("DEPRECATION") intent.getParcelableExtra(Intent.EXTRA_INTENT)
                if (confirm != null) WatchUpdate.confirm(ctx, confirm, tag)
            }
            PackageInstaller.STATUS_SUCCESS -> Log.i("LiftTraceUpdate", "updated to $tag")
            PackageInstaller.STATUS_FAILURE_ABORTED -> {
                // Declined (or left to go and allow installs: opening the app
                // again after that still offers it, see check).
                Log.i("LiftTraceUpdate", "update to $tag not now")
                WatchUpdate.declined(ctx, tag)
            }
            else -> {
                Log.w("LiftTraceUpdate", "install of $tag: status $status " + intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE))
                WatchUpdate.failed(ctx, tag)
            }
        }
    }
}
