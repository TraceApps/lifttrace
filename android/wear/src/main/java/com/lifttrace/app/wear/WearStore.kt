package com.lifttrace.app.wear

import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject
import java.time.LocalDate

/**
 * What the watch shows, and how it gets there.
 *
 * Every screen reads this one state. Opening draws the last session first, so
 * the watch is useful the instant it wakes, then replaces it with the
 * server's answer. A set changed here shows at once and goes up straight
 * away, or waits until there is a connection: a gym is exactly where there
 * isn't one.
 *
 * Sending is deliberately read-then-write, the same as the phone: the day is
 * fetched again, the watch's own changes are replayed onto it, and that goes
 * back. A session's name, notes, length and whether it was finished are
 * therefore the server's, never a stale copy the watch happened to be
 * holding, and a set the phone logged in the meantime survives.
 */
class WearStore(private val ctx: Context) {

    data class State(
        val paired: Boolean = false,
        val loading: Boolean = false,
        val offline: Boolean = false,
        val error: String? = null,
        val pending: Int = 0,
        /** A word about what just happened, shown for a moment. */
        val flash: String? = null,
        val workout: Session.Workout? = null,
        val unit: String = "lbs",
        val restSeconds: Int = 90,
        val restEnabled: Boolean = false,
        val restAutoStart: Boolean = true,
        /** What you did of each exercise last time, by catalogue id or name. */
        val lastTimes: Map<String, String> = emptyMap(),
        /** The phone's workout timer, when one is running for today. */
        val session: Pairing.SessionTimer? = null,
    )

    private val _state = MutableStateFlow(State(paired = Pairing.config(ctx) != null))
    val state: StateFlow<State> = _state

    /**
     * Sending belongs to the store, not to whatever screen happened to be up
     * when the wearer tapped. A set logged on the last screen of a session
     * goes up even though that screen is gone by the time the request is made.
     */
    private val work = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    /** One send at a time: two at once would read the same day twice and race. */
    private val sending = Mutex()

    /**
     * The phone's half of things arrives on a background service and is
     * written down rather than handed over, so the app listens for it. Without
     * this, stopping the timer on the phone would not show here until the
     * watch next went looking, which could be the better part of a minute.
     * Held as a field: what registers this keeps only a weak reference.
     */
    private val watcher = Pairing.watch(ctx) { key ->
        when (key) {
            Pairing.KEY_SESSION -> _state.update { it.copy(session = sessionTimer()) }
            Pairing.KEY_URL, Pairing.KEY_TOKEN ->
                _state.update { it.copy(paired = Pairing.config(ctx) != null) }
        }
    }

    private val today: String get() = LocalDate.now().toString()

    init {
        restore()
    }

    /** Draw whatever the watch last saw, before anything touches the network. */
    private fun restore() {
        val settings = Pairing.settings(ctx)
        // Only today's. Yesterday's session drawn on a new morning would be
        // something you could log into, and every set would land on yesterday.
        val cached = Pairing.cache(ctx)
            ?.let { runCatching { Session.parse(it) }.getOrNull() }
            ?.takeIf { it.date == today }
        _state.update { it.copy(
            workout = cached,
            unit = Session.weightUnit(settings),
            restSeconds = Session.restSeconds(settings),
            restEnabled = Session.restEnabled(settings),
            restAutoStart = Session.restAutoStart(settings),
            pending = Pairing.outbox(ctx).size,
            lastTimes = Pairing.lastTimes(ctx),
            session = sessionTimer(),
        ) }
    }

    /**
     * Catch up with the server: send anything waiting, then read the day back.
     * Called when the app opens, when it comes back to the front, and every so
     * often while it is open, so a set logged on the phone appears here too.
     */
    suspend fun refresh(quiet: Boolean = false) {
        val cfg = Pairing.pullFromPhone(ctx) ?: run {
            _state.update { it.copy(paired = false) }
            return
        }
        _state.update { it.copy(paired = true, loading = !quiet, error = null) }
        // Sending already ends with the server's own answer, so a flush that
        // did the work leaves nothing to read back.
        if (Pairing.outbox(ctx).isNotEmpty() && flush(cfg)) {
            _state.update { it.copy(loading = false) }
            readSettings(cfg)
            readLastTimes(cfg)
            return
        }
        try {
            readSettings(cfg)
            readLastTimes(cfg)
            val body = LiftApi.workout(cfg, today, sessionId())
            val workout = Session.parse(body)
            // Anything still waiting is the watch's own, and it is newer than
            // what came back: keep it on screen rather than letting the
            // server's answer undo it in front of the wearer.
            val waiting = Pairing.outbox(ctx)
            // Only this day's. A template copied into two days can carry the
            // same set ids into both, and laying yesterday's change over
            // today's session would tick off a set nobody has done.
            val shown = workout?.let { w ->
                waiting.filter { it.date == w.date }
                    .fold(w) { acc, op -> op.change?.let { Session.applyChange(acc, it) } ?: acc }
            }
            if (shown != null) Pairing.putCache(ctx, wrap(shown))
            else Pairing.putCache(ctx, body)
            redrawSurfaces()
            _state.update { it.copy(
                loading = false, offline = false, error = null,
                workout = shown,
                pending = waiting.size,
                session = sessionTimer(),
            ) }
        } catch (e: Exception) {
            handle(e, quiet)
        }
    }

    /**
     * What you did of each exercise last time, asked for once a day. It is one
     * request for the lot, and what it works out is kept, so the line is there
     * in a basement as well as on wifi.
     */
    private suspend fun readLastTimes(cfg: Pairing.Config) {
        if (Pairing.lastTimesDay(ctx) == today) return
        runCatching {
            val lines = Session.lastTimes(LiftApi.recent(cfg), today, _state.value.unit)
            Pairing.putLastTimes(ctx, today, lines)
            _state.update { it.copy(lastTimes = lines) }
        }
    }

    private suspend fun readSettings(cfg: Pairing.Config) {
        val settings = LiftApi.settings(cfg)
        if (settings.length() == 0) return
        Pairing.putSettings(ctx, settings)
        _state.update { it.copy(
            unit = Session.weightUnit(settings),
            restSeconds = Session.restSeconds(settings),
            restEnabled = Session.restEnabled(settings),
            restAutoStart = Session.restAutoStart(settings),
        ) }
    }

    /**
     * How long to rest after a set on this exercise: the plan's own rest when
     * it sets one, the account's otherwise.
     */
    fun restFor(exerciseUuid: String?, workout: Session.Workout? = null): Int {
        val day = workout ?: _state.value.workout
        if (day == null || exerciseUuid == null) return _state.value.restSeconds
        return Session.restFor(day, exerciseUuid, Pairing.settings(ctx))
    }

    /**
     * A set, as it now reads. Logging one, correcting one, un-ticking one and
     * adding one all come through here: to the server they are the same thing,
     * one set written into the day.
     */
    suspend fun save(change: Session.Change, flash: String? = null) {
        val current = _state.value.workout ?: return
        val updated = Session.applyChange(current, change)
        _state.update { it.copy(workout = updated, flash = flash) }
        Pairing.putCache(ctx, wrap(updated))
        redrawSurfaces()
        Pairing.queue(ctx, Pairing.Op(updated.date.ifBlank { today }, updated.id, change))
        _state.update { it.copy(pending = Pairing.outbox(ctx).size) }
        send()
    }

    /**
     * A hold is starting: write down which set it is for, so it is logged when
     * it ends whether the watch is still showing it or not.
     */
    fun armHold(change: Session.Change) {
        val day = _state.value.workout ?: return
        Pairing.armHold(ctx, Pairing.Op(day.date.ifBlank { today }, day.id, change))
    }

    /** The hold ended while the app was watching. */
    fun completeHold() {
        if (!Pairing.completeHold(ctx)) return
        restore()
        _state.update { it.copy(flash = "Hold logged") }
        send()
    }

    /** Send what is waiting, on the store's own time. */
    private fun send() {
        val cfg = Pairing.config(ctx) ?: return
        work.launch { flush(cfg) }
    }

    // ── The session's own clock ──────────────────────────────────────────

    /**
     * Start, pause, resume, stop. One timer, which either the watch or the
     * phone can drive: what is kept is a start time and a running total, so
     * both sides show the same number without either having to be awake.
     */
    fun startSession() {
        publishSession(Pairing.SessionTimer(today, System.currentTimeMillis(), 0.0, false, 0.0))
    }

    fun pauseSession() {
        val timer = _state.value.session ?: return
        if (timer.paused) return
        publishSession(timer.pausedAt(System.currentTimeMillis()))
    }

    fun resumeSession() {
        val timer = _state.value.session ?: return
        if (!timer.paused) return
        publishSession(timer.resumedAt(System.currentTimeMillis()))
    }

    /**
     * Done timing. The length goes onto the session the same way a set does,
     * queued if there is no signal, so it is written down whether or not the
     * phone is ever opened in the gym.
     */
    suspend fun stopSession() {
        val timer = _state.value.session ?: return
        val minutes = timer.minutes(System.currentTimeMillis())
        publishSession(null)
        val day = _state.value.workout
        if (day == null) {
            // Nothing to put the time on, and saying "Time saved" would be a
            // lie. The timer still stops.
            _state.update { it.copy(error = "No session to put that time on") }
            return
        }
        Pairing.queue(ctx, Pairing.Op(day.date.ifBlank { today }, day.id, minutes = minutes))
        _state.update { it.copy(pending = Pairing.outbox(ctx).size, flash = "Time saved") }
        send()
    }

    /**
     * Throw the time away: the timer stops and the session's length goes back
     * to nothing, which is what "Reset timer" does on the phone. Queued like
     * anything else, so it holds with no signal.
     */
    suspend fun discardSession() {
        publishSession(null)
        val day = _state.value.workout
        if (day == null) {
            _state.update { it.copy(flash = "Time discarded") }
            return
        }
        Pairing.queue(ctx, Pairing.Op(day.date.ifBlank { today }, day.id, minutes = 0.0))
        _state.update { it.copy(pending = Pairing.outbox(ctx).size, flash = "Time discarded") }
        send()
    }

    /**
     * The session is over, said from the wrist.
     *
     * Everything this needs is already here: the sets are logged, the clock
     * knows how long it ran, and the day goes back the same way a set does.
     * Sending someone to their phone to press one more button, after they
     * have done the whole workout on their watch, is the app getting in the
     * way of the thing it is for.
     *
     * Queued like anything else, so a gym with no signal still finishes the
     * session; it goes up with the rest of the work when there is one.
     */
    suspend fun finishSession() {
        val day = _state.value.workout ?: run {
            _state.update { it.copy(error = "No session to finish") }
            return
        }
        // Whatever the clock says, before it is stopped. A session finished
        // on the wrist should carry its length with it.
        val timer = _state.value.session
        val minutes = timer?.minutes(System.currentTimeMillis())
        if (timer != null) publishSession(null)
        Pairing.queue(
            ctx,
            Pairing.Op(day.date.ifBlank { today }, day.id, minutes = minutes, finished = true),
        )
        // Shown as finished at once: the wearer is walking out of the gym,
        // not waiting for a server.
        val body = JSONObject(day.raw.toString()).put("completed", 1)
        minutes?.let { body.put("duration_min", it) }
        val updated = Session.parse(JSONObject().put("workout", body).toString())
        if (updated != null) {
            Pairing.putCache(ctx, wrap(updated))
            _state.update { it.copy(workout = updated) }
        }
        _state.update { it.copy(pending = Pairing.outbox(ctx).size, flash = "Session finished") }
        redrawSurfaces()
        send()
    }

    private fun publishSession(timer: Pairing.SessionTimer?) {
        Pairing.publishSession(ctx, timer)
        _state.update { it.copy(session = sessionTimer()) }
    }

    /**
     * Send what is waiting. The day is read again first and the watch's own
     * changes are replayed onto it, so what goes back carries everything the
     * phone did in the meantime rather than overwriting it.
     */
    suspend fun flush(cfg: Pairing.Config): Boolean = sending.withLock { flushOnce(cfg) }

    private suspend fun flushOnce(cfg: Pairing.Config): Boolean {
        val waiting = Pairing.outbox(ctx)
        if (waiting.isEmpty()) return true
        val date = waiting.first().date.ifBlank { today }
        val id = waiting.first().workoutId
        val batch = waiting.filter { it.date == date }
        return try {
            val server = Session.parse(LiftApi.workout(cfg, date, id))
            if (server == null) {
                // The session was deleted on the phone while the watch held
                // changes for it. Recreating it behind the wearer's back would
                // be worse than saying so.
                forget(batch)
                _state.update { it.copy(
                    pending = Pairing.outbox(ctx).size,
                    error = "That session is no longer on your server",
                ) }
                return false
            }
            var body = server.raw
            for (op in batch) {
                op.change?.let { body = Session.upsert(body, it) }
                op.minutes?.let { body.put("duration_min", it) }
                if (op.finished) body.put("completed", 1)
            }
            val saved = LiftApi.saveWorkout(cfg, date, body)
            // Only what actually went up comes off the queue. Anything logged
            // while this was in the air is a later entry and stays.
            forget(batch)
            val workout = Session.parse(saved)
            if (workout != null) {
                Pairing.putCache(ctx, wrap(workout))
                redrawSurfaces()
            }
            _state.update { it.copy(
                pending = Pairing.outbox(ctx).size,
                offline = false,
                error = null,
                workout = workout ?: it.workout,
            ) }
            true
        } catch (e: Exception) {
            // A refusal from the server is worth saying out loud here: this is
            // the moment the wearer's work either arrives or does not.
            handle(e, quiet = false)
            false
        }
    }

    /** Take the entries that went up off the queue, and nothing else. */
    private fun forget(sent: List<Pairing.Op>) {
        val seqs = sent.map { it.seq }.toSet()
        Pairing.writeOutbox(ctx, Pairing.outbox(ctx).filterNot { it.seq in seqs })
    }

    fun clearFlash() {
        _state.update { if (it.flash == null) it else it.copy(flash = null) }
    }

    /**
     * The phone's workout timer, if it is running for today. Yesterday's is
     * not this session's, and a watch that was out of range when the phone
     * cleared it should not keep counting a session that ended.
     */
    private fun sessionTimer(): Pairing.SessionTimer? =
        Pairing.session(ctx)?.takeIf { it.date == today }

    /** The session the watch is in, so a date with more than one keeps its place. */
    private fun sessionId(): Long = _state.value.workout?.id ?: 0L

    private fun wrap(workout: Session.Workout): String =
        JSONObject().put("workout", workout.raw).toString()

    private fun handle(e: Exception, quiet: Boolean) {
        if (isRefused(e)) {
            // The token expired or was revoked. Saying "pair from your phone"
            // is the only useful thing here, and the phone hands over a fresh
            // one next time it is opened. Changes waiting are kept: they are
            // still good.
            Pairing.forget(ctx)
            _state.update { it.copy(paired = false, loading = false, error = null) }
            return
        }
        _state.update { it.copy(
            loading = false,
            offline = isOffline(e),
            error = if (isOffline(e) || quiet) null else (e.message ?: "Couldn't reach LiftTrace"),
        ) }
    }

    /**
     * The tile and the watch face read the same saved session, so they are
     * told whenever it changes rather than waiting for their own schedule.
     */
    private fun redrawSurfaces() {
        SessionTileService.refresh(ctx)
        SetsComplicationService.refresh(ctx)
    }

    private fun isRefused(e: Exception): Boolean =
        e is LiftApi.ApiError && (e.code == 401 || e.code == 403)

    private fun isOffline(e: Exception): Boolean = e !is LiftApi.ApiError
}
