package com.lifttrace.app.wear

import org.json.JSONArray
import org.json.JSONObject

/**
 * A session as the watch understands it, and the few decisions it has to make:
 * which set you are on, what to fill in for it, and what to send back.
 *
 * Everything here is plain data in, plain data out, so it can be tested
 * without a watch (src/test). LiftApi does the talking, WearStore holds the
 * state, MainActivity draws it.
 *
 * The shape is the server's own (`GET /api/workout/<date>`): a workout with
 * exercises, each with sets that carry `reps`, `weight` and `completed`. The
 * watch sends the whole day back the way every other client does, so the
 * merge on the server is the one already in use.
 */
object Session {

    data class Set(
        val uuid: String,
        val reps: Int,
        val weight: Double,
        val completed: Boolean,
        val warmup: Boolean,
    )

    data class Exercise(
        val uuid: String,
        val name: String,
        val sets: List<Set>,
    ) {
        val done: Int get() = sets.count { it.completed }
        val total: Int get() = sets.size
    }

    data class Workout(
        val id: Long,
        val date: String,
        val name: String,
        val exercises: List<Exercise>,
        /** The whole row as it came, so what the watch doesn't understand survives. */
        val raw: JSONObject,
    ) {
        val setsDone: Int get() = exercises.sumOf { it.done }
        val setsTotal: Int get() = exercises.sumOf { it.total }
        val finished: Boolean get() = setsTotal > 0 && setsDone == setsTotal
    }

    /** Where you are: the first set that has not been done yet. */
    data class Next(val exercise: Exercise, val set: Set, val setNumber: Int)

    fun parse(body: String): Workout? {
        val root = JSONObject(body)
        val w = root.optJSONObject("workout") ?: return null
        if (w.optBoolean("_none", false)) return null
        val exercises = mutableListOf<Exercise>()
        val list = w.optJSONArray("exercises") ?: JSONArray()
        for (i in 0 until list.length()) {
            val e = list.optJSONObject(i) ?: continue
            val sets = mutableListOf<Set>()
            val rawSets = e.optJSONArray("sets") ?: JSONArray()
            for (j in 0 until rawSets.length()) {
                val s = rawSets.optJSONObject(j) ?: continue
                sets.add(
                    Set(
                        uuid = s.optString("uuid"),
                        reps = s.optInt("reps", 0),
                        weight = s.optDouble("weight", 0.0).let { if (it.isNaN()) 0.0 else it },
                        completed = s.optBoolean("completed", false),
                        warmup = s.optBoolean("warmup", false),
                    )
                )
            }
            exercises.add(
                Exercise(
                    uuid = e.optString("uuid"),
                    name = e.optString("exercise_name").ifBlank { "Exercise" },
                    sets = sets,
                )
            )
        }
        return Workout(
            id = w.optLong("id", 0L),
            date = w.optString("date"),
            name = w.optString("name").ifBlank { "Today" },
            exercises = exercises,
            raw = w,
        )
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
    fun suggest(exercise: Exercise, setIndex: Int): Pair<Double, Int> {
        val target = exercise.sets.getOrNull(setIndex)
        val earlier = exercise.sets.take(maxOf(0, setIndex)).lastOrNull { it.weight > 0 || it.reps > 0 }
            ?: exercise.sets.lastOrNull { it.completed }
        val weight = if ((target?.weight ?: 0.0) > 0) target!!.weight else (earlier?.weight ?: 0.0)
        val reps = if ((target?.reps ?: 0) > 0) target!!.reps else (earlier?.reps ?: 0)
        return weight to reps
    }

    /**
     * The day with one set marked done, ready to send back. The rest of the
     * row is untouched: the watch only ever changes the set in front of you.
     */
    fun withSetLogged(workout: Workout, exerciseUuid: String, setUuid: String, weight: Double, reps: Int): JSONObject {
        val body = JSONObject(workout.raw.toString())
        val exercises = body.optJSONArray("exercises") ?: JSONArray()
        for (i in 0 until exercises.length()) {
            val e = exercises.optJSONObject(i) ?: continue
            if (e.optString("uuid") != exerciseUuid) continue
            val sets = e.optJSONArray("sets") ?: continue
            for (j in 0 until sets.length()) {
                val s = sets.optJSONObject(j) ?: continue
                if (s.optString("uuid") != setUuid) continue
                s.put("completed", true)
                s.put("weight", weight)
                s.put("reps", reps)
            }
        }
        // The id says which session to change when a date holds more than one.
        if (workout.id > 0) body.put("id", workout.id)
        return body
    }

    /** The same change applied to what the watch is showing, so it updates at once. */
    fun applyLogged(workout: Workout, exerciseUuid: String, setUuid: String, weight: Double, reps: Int): Workout {
        val exercises = workout.exercises.map { e ->
            if (e.uuid != exerciseUuid) e
            else e.copy(sets = e.sets.map { s ->
                if (s.uuid != setUuid) s else s.copy(completed = true, weight = weight, reps = reps)
            })
        }
        return workout.copy(
            exercises = exercises,
            raw = withSetLogged(workout, exerciseUuid, setUuid, weight, reps),
        )
    }

    /** "3 of 12 sets", and what a tile or a complication shows at a glance. */
    fun progress(workout: Workout?): String {
        val w = workout ?: return "No session"
        if (w.setsTotal == 0) return "No sets yet"
        return "${w.setsDone} of ${w.setsTotal}"
    }

    /** A weight without a pointless decimal: 60 rather than 60.0, 62.5 as it is. */
    fun weightText(weight: Double, unit: String): String {
        if (weight <= 0) return "Bodyweight"
        val rounded = Math.round(weight * 10.0) / 10.0
        val number = if (rounded % 1.0 == 0.0) rounded.toLong().toString() else rounded.toString()
        return "$number $unit"
    }

    /**
     * How much a tap on + or - moves the weight: the smallest plate pair in
     * each unit, so a tap is a change you could actually make on the bar.
     */
    fun weightStep(unit: String): Double = if (unit == "kg") 2.5 else 5.0

    /** Counting down, as a watch shows it: 1:30, 0:45. */
    fun clock(seconds: Int): String {
        val safe = maxOf(0, seconds)
        return "${safe / 60}:${(safe % 60).toString().padStart(2, '0')}"
    }

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
