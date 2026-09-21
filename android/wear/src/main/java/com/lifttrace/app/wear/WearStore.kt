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
 * server's answer. A set logged here shows at once and goes up straight away,
 * or waits in the outbox until there is a connection: a gym is exactly where
 * there isn't one.
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
            workout = cached?.let { withQueued(it) },
            unit = Session.weightUnit(settings),
            restSeconds = Session.restSeconds(settings),
            restAutoStart = Session.restAutoStart(settings),
            pending = Pairing.outbox(ctx).size,
        )
    }

    /** The session with anything still waiting laid over it. */
    private fun withQueued(workout: Session.Workout): Session.Workout {
        var out = workout
        for (op in Pairing.outbox(ctx)) {
            if (op.date != workout.date) continue
            out = Session.applyLogged(out, op.exerciseUuid, op.setUuid, op.weight, op.reps)
        }
        return out
    }

    suspend fun refresh() {
        val cfg = Pairing.pullFromPhone(ctx) ?: run {
            _state.value = _state.value.copy(paired = false)
            return
        }
        _state.value = _state.value.copy(paired = true, loading = true, error = null)
        flush(cfg)
        try {
            val settings = LiftApi.settings(cfg)
            Pairing.putSettings(ctx, settings)
            val body = LiftApi.workout(cfg, today)
            Pairing.putCache(ctx, body)
            redrawSurfaces()
            val workout = Session.parse(body)
            _state.value = _state.value.copy(
                loading = false, offline = false, error = null,
                workout = workout?.let { withQueued(it) },
                unit = Session.weightUnit(settings),
                restSeconds = Session.restSeconds(settings),
                restAutoStart = Session.restAutoStart(settings),
                pending = Pairing.outbox(ctx).size,
            )
        } catch (e: Exception) {
            if (isRefused(e)) {
                // The token expired or was revoked. Saying "pair from your
                // phone" is the only useful thing here, and the phone hands
                // over a fresh one next time it is opened. Sets waiting in the
                // outbox are kept: they are still good.
                Pairing.forget(ctx)
                _state.value = _state.value.copy(paired = false, loading = false, error = null)
                return
            }
            _state.value = _state.value.copy(
                loading = false,
                offline = isOffline(e),
                error = if (isOffline(e)) null else (e.message ?: "Couldn't reach LiftTrace"),
            )
        }
    }

    /**
     * The set in front of you, done. It shows immediately, and goes up now or
     * when there is a connection.
     */
    suspend fun logSet(exerciseUuid: String, setUuid: String, weight: Double, reps: Int) {
        val current = _state.value.workout ?: return
        val updated = Session.applyLogged(current, exerciseUuid, setUuid, weight, reps)
        _state.value = _state.value.copy(workout = updated, flash = "Set logged")
        Pairing.putCache(ctx, JSONObject().put("workout", updated.raw).toString())
        redrawSurfaces()
        Pairing.queue(
            ctx,
            Pairing.Op(
                date = updated.date.ifBlank { today },
                workoutId = updated.id,
                exerciseUuid = exerciseUuid,
                setUuid = setUuid,
                weight = weight,
                reps = reps,
            ),
        )
        _state.value = _state.value.copy(pending = Pairing.outbox(ctx).size)
        Pairing.config(ctx)?.let { flush(it) }
    }

    /**
     * Send what is waiting. The whole day goes up, exactly as the phone sends
     * it, so the server merges the watch's sets with anything else that
     * happened rather than one copy overwriting the other.
     */
    suspend fun flush(cfg: Pairing.Config): Boolean {
        val waiting = Pairing.outbox(ctx)
        if (waiting.isEmpty()) return true
        val workout = _state.value.workout ?: return false
        return try {
            val date = waiting.first().date.ifBlank { today }
            LiftApi.saveWorkout(cfg, date, workout.raw)
            Pairing.writeOutbox(ctx, waiting.filterNot { it.date == date })
            _state.value = _state.value.copy(pending = Pairing.outbox(ctx).size, offline = false)
            true
        } catch (e: Exception) {
            if (isRefused(e)) {
                Pairing.forget(ctx)
                _state.value = _state.value.copy(paired = false)
                return false
            }
            // Still no connection, or the server said no: the sets stay put.
            _state.value = _state.value.copy(
                offline = isOffline(e),
                error = if (isOffline(e)) null else (e.message ?: "Couldn't reach LiftTrace"),
            )
            false
        }
    }

    fun clearFlash() {
        if (_state.value.flash != null) _state.value = _state.value.copy(flash = null)
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
