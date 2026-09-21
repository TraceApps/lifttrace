package com.lifttrace.app.wear

import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/**
 * A session as the watch understands it, and the few decisions it has to make:
 * which set you are on, what to fill in for it, and what to send back.
 *
 * Everything here is plain data in, plain data out, so it can be tested
 * without a watch (src/test). LiftApi does the talking, WearStore holds the
 * state, MainActivity draws it.
 *
 * The shape is the server's own (`GET /api/workout/<date>`): a workout with
 * exercises, each with sets. A set is reps and weight, or a hold in seconds,
 * or reps recorded per side, exactly as the phone records them, and the watch
 * writes back the same fields the phone writes rather than a shape of its own.
 * The whole day goes back on every save, the way every other client sends it,
 * so the merge on the server is the one already in use.
 */
object Session {

    const val TYPE_REPS = "reps"
    const val TYPE_TIME = "time"
    const val LOAD_BILATERAL = "bilateral"
    const val LOAD_UNILATERAL = "unilateral"
    const val LOAD_PAIRED = "paired"

    data class Set(
        val uuid: String,
        val reps: Int,
        /** Reps recorded per side. Null unless the phone split this set. */
        val repsLeft: Int?,
        val repsRight: Int?,
        val weight: Double,
        val durationSec: Int,
        val completed: Boolean,
        val warmup: Boolean,
    ) {
        /** A set the phone is recording per side, as it does for alternating work. */
        val split: Boolean get() = repsLeft != null || repsRight != null

        /** Has anything been put on this set, by you or by the plan? */
        val hasNumbers: Boolean
            get() = weight > 0 || reps > 0 || durationSec > 0 || (repsLeft ?: 0) > 0 || (repsRight ?: 0) > 0
    }

    data class Exercise(
        val uuid: String,
        val name: String,
        val setType: String,
        val loadType: String,
        val sets: List<Set>,
    ) {
        val timed: Boolean get() = setType == TYPE_TIME
        val done: Int get() = sets.count { it.completed }
        val total: Int get() = sets.size
        val finished: Boolean get() = total > 0 && done == total
    }

    data class Workout(
        val id: Long,
        val date: String,
        val name: String,
        val completed: Boolean,
        val exercises: List<Exercise>,
        /** The whole row as it came, so what the watch doesn't understand survives. */
        val raw: JSONObject,
    ) {
        val setsDone: Int get() = exercises.sumOf { it.done }
        val setsTotal: Int get() = exercises.sumOf { it.total }
        val finished: Boolean get() = setsTotal > 0 && setsDone == setsTotal
        fun exercise(uuid: String): Exercise? = exercises.firstOrNull { it.uuid == uuid }
        fun set(exerciseUuid: String, setUuid: String): Set? =
            exercise(exerciseUuid)?.sets?.firstOrNull { it.uuid == setUuid }
    }

    /** Where you are: the first set that has not been done yet. */
    data class Next(val exercise: Exercise, val set: Set, val setNumber: Int)

    /**
     * One set as the watch now says it reads. Every edit the watch makes is
     * one of these: logging a set, correcting one, un-ticking one, or adding
     * one (a uuid the day has never seen). Replaying it onto whatever the
     * server currently holds is how a change survives a phone that moved the
     * same session in the meantime.
     */
    data class Change(
        val exerciseUuid: String,
        val setUuid: String,
        val weight: Double,
        val reps: Int,
        val repsLeft: Int?,
        val repsRight: Int?,
        val durationSec: Int,
        val completed: Boolean,
        val warmup: Boolean,
    )

    // ── Reading ──────────────────────────────────────────────────────────

    fun parse(body: String): Workout? {
        val root = JSONObject(body)
        val w = root.optJSONObject("workout") ?: return null
        // A session deleted on the phone still answers a request that names it
        // by id, so that an undo can put it back. The watch is not that undo:
        // a set logged here must never quietly resurrect a session the wearer
        // threw away on the phone.
        if (!w.isNull("deleted_at") && w.optString("deleted_at").isNotBlank()) return null
        // A coach's notes come down with the day. The watch has no screen for
        // them and no business keeping someone's written feedback in a
        // wrist-worn cache, so they are dropped here: the server ignores the
        // field on the way back, and the phone is where they are read.
        w.remove("feedback")
        val exercises = mutableListOf<Exercise>()
        val list = w.optJSONArray("exercises") ?: JSONArray()
        for (i in 0 until list.length()) {
            val e = list.optJSONObject(i) ?: continue
            val sets = mutableListOf<Set>()
            val rawSets = e.optJSONArray("sets") ?: JSONArray()
            for (j in 0 until rawSets.length()) {
                val s = rawSets.optJSONObject(j) ?: continue
                sets.add(readSet(s))
            }
            exercises.add(
                Exercise(
                    uuid = e.optString("uuid"),
                    name = e.optString("exercise_name").ifBlank { "Exercise" },
                    setType = setType(e, sets),
                    loadType = loadType(e),
                    sets = sets,
                )
            )
        }
        return Workout(
            id = w.optLong("id", 0L),
            date = w.optString("date"),
            name = w.optString("name").ifBlank { "Today" },
            completed = w.optInt("completed", 0) == 1 || w.optBoolean("completed", false),
            exercises = exercises,
            raw = w,
        )
    }

    private fun readSet(s: JSONObject): Set = Set(
        uuid = s.optString("uuid"),
        reps = s.optInt("reps", 0),
        repsLeft = if (s.isNull("reps_l")) null else s.optInt("reps_l", 0),
        repsRight = if (s.isNull("reps_r")) null else s.optInt("reps_r", 0),
        weight = s.optDouble("weight", 0.0).let { if (it.isNaN()) 0.0 else it },
        durationSec = s.optInt("duration_sec", 0),
        completed = s.optBoolean("completed", false),
        warmup = s.optBoolean("warmup", false),
    )

    /**
     * Reps or a hold, worked out the way the phone works it out: what the
     * exercise says, then what the library said when it was added, then what
     * the sets themselves carry. The phone's last resort is a guess from the
     * exercise's name, which needs the catalogue, so the watch stops at reps.
     */
    private fun setType(e: JSONObject, sets: List<Set>): String {
        val own = e.optString("set_type").lowercase()
        if (own == TYPE_TIME || own == TYPE_REPS) return own
        val library = e.optString("_library_set_type").lowercase()
        if (library == TYPE_TIME || library == TYPE_REPS) return library
        if (sets.any { it.durationSec > 0 }) return TYPE_TIME
        return TYPE_REPS
    }

    private fun loadType(e: JSONObject): String {
        val own = e.optString("load_type").lowercase().ifBlank {
            e.optString("_library_load_type").lowercase()
        }
        return when (own) {
            LOAD_UNILATERAL, LOAD_PAIRED, LOAD_BILATERAL -> own
            else -> LOAD_BILATERAL
        }
    }

    /**
     * The set you are on: the first one not yet done, warm-ups included, since
     * they are part of the session as it was planned.
     */
    fun next(workout: Workout?): Next? {
        val w = workout ?: return null
        for (e in w.exercises) {
            val idx = e.sets.indexOfFirst { !it.completed }
            if (idx >= 0) return Next(e, e.sets[idx], idx + 1)
        }
        return null
    }

    /**
     * What to fill in for the set in front of you: what the plan says, and for
     * anything the plan leaves blank, what the set before it did. A watch is
     * not the place to type numbers in from scratch, and a programme that
     * prescribes reps but leaves the weight to you is the usual case, not an
     * odd one.
     */
    fun suggest(exercise: Exercise, setIndex: Int): Change {
        val target = exercise.sets.getOrNull(setIndex)
        val earlier = exercise.sets.take(maxOf(0, setIndex)).lastOrNull { it.hasNumbers }
            ?: exercise.sets.lastOrNull { it.completed }
        fun <T : Comparable<T>> pick(mine: T?, theirs: T?, zero: T): T =
            if (mine != null && mine > zero) mine else (theirs ?: zero)
        val split = target?.split == true || (target?.hasNumbers != true && earlier?.split == true)
        return Change(
            exerciseUuid = exercise.uuid,
            setUuid = target?.uuid ?: newSetUuid(),
            weight = pick(target?.weight, earlier?.weight, 0.0),
            reps = pick(target?.reps, earlier?.reps, 0),
            repsLeft = if (split) pick(target?.repsLeft, earlier?.repsLeft, 0) else null,
            repsRight = if (split) pick(target?.repsRight, earlier?.repsRight, 0) else null,
            durationSec = pick(target?.durationSec, earlier?.durationSec, 0),
            completed = target?.completed ?: false,
            warmup = target?.warmup ?: false,
        )
    }

    /** A set to add to the end of an exercise, carrying the last one's numbers. */
    fun addition(exercise: Exercise): Change =
        suggest(exercise, exercise.sets.size).copy(
            setUuid = newSetUuid(),
            completed = false,
            warmup = false,
        )

    fun newSetUuid(): String = UUID.randomUUID().toString()

    // ── Writing ──────────────────────────────────────────────────────────

    /**
     * A day with one set written into it, whether that set was already there
     * or is new. Everything else in the row is left exactly as it came, which
     * is what keeps a session's name, notes and length from being flattened by
     * a watch that only ever knew about one set.
     */
    fun upsert(raw: JSONObject, change: Change): JSONObject {
        val body = JSONObject(raw.toString())
        val exercises = body.optJSONArray("exercises") ?: return body
        for (i in 0 until exercises.length()) {
            val e = exercises.optJSONObject(i) ?: continue
            if (e.optString("uuid") != change.exerciseUuid) continue
            val sets = e.optJSONArray("sets") ?: JSONArray().also { e.put("sets", it) }
            var found = false
            for (j in 0 until sets.length()) {
                val s = sets.optJSONObject(j) ?: continue
                if (s.optString("uuid") != change.setUuid) continue
                write(s, change)
                found = true
            }
            if (!found) sets.put(write(JSONObject().put("uuid", change.setUuid), change))
        }
        return body
    }

    private fun write(s: JSONObject, change: Change): JSONObject {
        s.put("weight", change.weight)
        s.put("reps", change.reps)
        s.put("completed", change.completed)
        if (change.warmup) s.put("warmup", true)
        if (change.durationSec > 0) s.put("duration_sec", change.durationSec)
        // A set the phone is keeping per side stays per side; one that is not
        // must not suddenly grow the fields, or the phone would draw it split.
        if (change.repsLeft != null) s.put("reps_l", change.repsLeft)
        if (change.repsRight != null) s.put("reps_r", change.repsRight)
        return s
    }

    /** The same change applied to what the watch is showing, so it updates at once. */
    fun applyChange(workout: Workout, change: Change): Workout {
        val exercises = workout.exercises.map { e ->
            if (e.uuid != change.exerciseUuid) return@map e
            val updated = Set(
                uuid = change.setUuid,
                reps = change.reps,
                repsLeft = change.repsLeft,
                repsRight = change.repsRight,
                weight = change.weight,
                durationSec = change.durationSec,
                completed = change.completed,
                warmup = change.warmup,
            )
            val sets = if (e.sets.any { it.uuid == change.setUuid }) {
                e.sets.map { if (it.uuid == change.setUuid) updated else it }
            } else {
                e.sets + updated
            }
            e.copy(sets = sets)
        }
        return workout.copy(exercises = exercises, raw = upsert(workout.raw, change))
    }

    // ── Words and numbers ────────────────────────────────────────────────

    /** "3 of 12", and what a tile or a complication shows at a glance. */
    fun progress(workout: Workout?): String {
        val w = workout ?: return "No session"
        if (w.setsTotal == 0) return "No sets yet"
        return "${w.setsDone} of ${w.setsTotal}"
    }

    /** One set on a list: what it says it is, in as few characters as possible. */
    fun setLine(exercise: Exercise, set: Set, unit: String): String {
        val load = if (set.weight > 0) weightText(set.weight, unit) else ""
        val work = when {
            exercise.timed && set.durationSec > 0 -> clock(set.durationSec)
            set.split -> "${set.repsLeft ?: 0} / ${set.repsRight ?: 0}"
            set.reps > 0 -> "${set.reps} reps"
            else -> ""
        }
        val text = listOf(load, work).filter { it.isNotBlank() }.joinToString(" x ")
        return text.ifBlank { if (exercise.timed) "No hold yet" else "Nothing on it yet" }
    }

    /** A weight without a pointless decimal: 60 rather than 60.0, 62.5 as it is. */
    fun weightText(weight: Double, unit: String): String {
        if (weight <= 0) return "Bodyweight"
        val rounded = Math.round(weight * 10.0) / 10.0
        val number = if (rounded % 1.0 == 0.0) rounded.toLong().toString() else rounded.toString()
        return "$number $unit"
    }

    /** Counting down, as a watch shows it: 1:30, 0:45. */
    fun clock(seconds: Int): String {
        val safe = maxOf(0, seconds)
        return "${safe / 60}:${(safe % 60).toString().padStart(2, '0')}"
    }

    /**
     * How much a tap on + or - moves the weight: the smallest plate pair in
     * each unit, so a tap is a change you could actually make on the bar. The
     * same steps the phone uses.
     */
    fun weightStep(unit: String): Double = if (unit == "kg") 2.5 else 5.0

    /**
     * How long to rest. The server's own setting when there is one, a minute
     * and a half otherwise, which is what LiftTrace itself defaults to.
     */
    fun restSeconds(settings: JSONObject?): Int {
        val raw = settings?.opt("restDuration")
        val seconds = when (raw) {
            is Number -> raw.toInt()
            is String -> raw.toIntOrNull() ?: 0
            else -> 0
        }
        return if (seconds in 5..3600) seconds else 90
    }

    /** Does the wearer want the timer to start by itself after a set? */
    fun restAutoStart(settings: JSONObject?): Boolean =
        settings?.opt("restAutoStart")?.let { it == true || it == "true" } ?: true

    /**
     * Pounds or kilos, written the way LiftTrace writes them. Pounds is the
     * app's own default, so an account that has never touched the setting
     * reads the same on the watch as it does on the phone.
     */
    fun weightUnit(settings: JSONObject?): String {
        val unit = settings?.optString("weightUnit").orEmpty().lowercase()
        return if (unit.startsWith("kg")) "kg" else "lbs"
    }
}
