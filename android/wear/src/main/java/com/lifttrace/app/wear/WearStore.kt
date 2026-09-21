package com.lifttrace.app.wear

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
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
    )

    private val _state = MutableStateFlow(State(paired = Pairing.config(ctx) != null))
    val state: StateFlow<State> = _state

    private val today: String get() = LocalDate.now().toString()

    init {
        restore()
    }

    /** Draw whatever the watch last saw, before anything touches the network. */
    private fun restore() {
        val settings = Pairing.settings(ctx)
        val cached = Pairing.cache(ctx)?.let { runCatching { Session.parse(it) }.getOrNull() }
        _state.value = _state.value.copy(
            workout = cached,
            unit = Session.weightUnit(settings),
            restSeconds = Session.restSeconds(settings),
            restEnabled = Session.restEnabled(settings),
            restAutoStart = Session.restAutoStart(settings),
            pending = Pairing.outbox(ctx).size,
        )
    }

    /**
     * Catch up with the server: send anything waiting, then read the day back.
     * Called when the app opens, when it comes back to the front, and every so
     * often while it is open, so a set logged on the phone appears here too.
     */
    suspend fun refresh(quiet: Boolean = false) {
        val cfg = Pairing.pullFromPhone(ctx) ?: run {
            _state.value = _state.value.copy(paired = false)
            return
        }
        _state.value = _state.value.copy(paired = true, loading = !quiet, error = null)
        // Sending already ends with the server's own answer, so a flush that
        // did the work leaves nothing to read back.
        if (Pairing.outbox(ctx).isNotEmpty() && flush(cfg)) {
            _state.value = _state.value.copy(loading = false)
            readSettings(cfg)
            return
        }
        try {
            readSettings(cfg)
            val body = LiftApi.workout(cfg, today, sessionId())
            val workout = Session.parse(body)
            // Anything still waiting is the watch's own, and it is newer than
            // what came back: keep it on screen rather than letting the
            // server's answer undo it in front of the wearer.
            val waiting = Pairing.outbox(ctx)
            val shown = workout?.let { w -> waiting.fold(w) { acc, op -> Session.applyChange(acc, op.change) } }
            if (shown != null) Pairing.putCache(ctx, wrap(shown))
            else Pairing.putCache(ctx, body)
            redrawSurfaces()
            _state.value = _state.value.copy(
                loading = false, offline = false, error = null,
                workout = shown,
                pending = waiting.size,
            )
        } catch (e: Exception) {
            handle(e, quiet)
        }
    }

    private suspend fun readSettings(cfg: Pairing.Config) {
        val settings = LiftApi.settings(cfg)
        if (settings.length() == 0) return
        Pairing.putSettings(ctx, settings)
        _state.value = _state.value.copy(
            unit = Session.weightUnit(settings),
            restSeconds = Session.restSeconds(settings),
            restEnabled = Session.restEnabled(settings),
            restAutoStart = Session.restAutoStart(settings),
        )
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
        _state.value = _state.value.copy(workout = updated, flash = flash)
        Pairing.putCache(ctx, wrap(updated))
        redrawSurfaces()
        Pairing.queue(ctx, Pairing.Op(updated.date.ifBlank { today }, updated.id, change))
        _state.value = _state.value.copy(pending = Pairing.outbox(ctx).size)
        Pairing.config(ctx)?.let { flush(it) }
    }

    /**
     * Send what is waiting. The day is read again first and the watch's own
     * changes are replayed onto it, so what goes back carries everything the
     * phone did in the meantime rather than overwriting it.
     */
    suspend fun flush(cfg: Pairing.Config): Boolean {
        val waiting = Pairing.outbox(ctx)
        if (waiting.isEmpty()) return true
        val date = waiting.first().date.ifBlank { today }
        val id = waiting.first().workoutId
        return try {
            val server = Session.parse(LiftApi.workout(cfg, date, id))
            if (server == null) {
                // The session was deleted on the phone while the watch held
                // changes for it. Recreating it behind the wearer's back would
                // be worse than saying so.
                Pairing.writeOutbox(ctx, waiting.filterNot { it.date == date })
                _state.value = _state.value.copy(
                    pending = Pairing.outbox(ctx).size,
                    error = "That session is no longer on your server",
                )
                return false
            }
            var body = server.raw
            for (op in waiting.filter { it.date == date }) body = Session.upsert(body, op.change)
            val saved = LiftApi.saveWorkout(cfg, date, body)
            Pairing.writeOutbox(ctx, waiting.filterNot { it.date == date })
            val workout = Session.parse(saved)
            if (workout != null) {
                Pairing.putCache(ctx, wrap(workout))
                redrawSurfaces()
            }
            _state.value = _state.value.copy(
                pending = Pairing.outbox(ctx).size,
                offline = false,
                error = null,
                workout = workout ?: _state.value.workout,
            )
            true
        } catch (e: Exception) {
            // A refusal from the server is worth saying out loud here: this is
            // the moment the wearer's work either arrives or does not.
            handle(e, quiet = false)
            false
        }
    }

    fun clearFlash() {
        if (_state.value.flash != null) _state.value = _state.value.copy(flash = null)
    }

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
            _state.value = _state.value.copy(paired = false, loading = false, error = null)
            return
        }
        _state.value = _state.value.copy(
            loading = false,
            offline = isOffline(e),
            error = if (isOffline(e) || quiet) null else (e.message ?: "Couldn't reach LiftTrace"),
        )
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
