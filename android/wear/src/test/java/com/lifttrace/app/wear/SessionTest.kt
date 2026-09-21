package com.lifttrace.app.wear

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The decisions the watch makes on its own: which set you are on, what to
 * fill in for it, and what goes back to the server. All of it is plain data
 * in and plain data out, so it is tested here rather than on a wrist.
 */
class SessionTest {

    private val body = """
        {"workout":{"id":7,"date":"2026-09-21","name":"Push A","exercises":[
          {"uuid":"e1","exercise_id":11,"exercise_name":"Bench Press","sets":[
            {"uuid":"s1","reps":10,"weight":135,"completed":true,"warmup":true},
            {"uuid":"s2","reps":8,"weight":185,"completed":false},
            {"uuid":"s3","reps":8,"weight":0,"completed":false}
          ]},
          {"uuid":"e2","exercise_id":12,"exercise_name":"Overhead Press","sets":[
            {"uuid":"s4","reps":10,"weight":95,"completed":false}
          ]}
        ]}}
    """.trimIndent()

    @Test
    fun `reads the day the server sent`() {
        val w = Session.parse(body)!!
        assertEquals(7L, w.id)
        assertEquals("Push A", w.name)
        assertEquals(2, w.exercises.size)
        assertEquals("Bench Press", w.exercises[0].name)
        assertEquals(4, w.setsTotal)
        assertEquals(1, w.setsDone)
        assertFalse(w.finished)
    }

    @Test
    fun `a day with no session is nothing to show`() {
        assertNull(Session.parse("""{"workout":null}"""))
        assertNull(Session.parse("""{}"""))
    }

    @Test
    fun `the set you are on is the first one not done`() {
        val next = Session.next(Session.parse(body))!!
        assertEquals("Bench Press", next.exercise.name)
        assertEquals("s2", next.set.uuid)
        assertEquals(2, next.setNumber)
    }

    @Test
    fun `nothing is next once every set is logged`() {
        var w = Session.parse(body)!!
        for (e in w.exercises) for (s in e.sets) w = Session.applyLogged(w, e.uuid, s.uuid, s.weight, s.reps)
        assertNull(Session.next(w))
        assertTrue(w.finished)
    }

    @Test
    fun `a planned set is offered as planned`() {
        val w = Session.parse(body)!!
        val (weight, reps) = Session.suggest(w.exercises[0], 1)
        assertEquals(185.0, weight, 0.001)
        assertEquals(8, reps)
    }

    @Test
    fun `a set with nothing on it borrows from the set before`() {
        val w = Session.parse(body)!!
        // s3 has no weight: the 185 from s2 is what you are most likely doing.
        val (weight, reps) = Session.suggest(w.exercises[0], 2)
        assertEquals(185.0, weight, 0.001)
        assertEquals(8, reps)
    }

    @Test
    fun `logging a set changes that set and nothing else`() {
        val w = Session.parse(body)!!
        val after = Session.applyLogged(w, "e1", "s2", 190.0, 7)
        val set = after.exercises[0].sets[1]
        assertTrue(set.completed)
        assertEquals(190.0, set.weight, 0.001)
        assertEquals(7, set.reps)
        // The other exercise is untouched.
        assertFalse(after.exercises[1].sets[0].completed)
        assertEquals(2, after.setsDone)
    }

    @Test
    fun `what goes up is the whole day, with the id that says which session`() {
        val w = Session.parse(body)!!
        val sent = Session.withSetLogged(w, "e1", "s2", 190.0, 7)
        assertEquals(7, sent.getInt("id"))
        val sets = sent.getJSONArray("exercises").getJSONObject(0).getJSONArray("sets")
        assertTrue(sets.getJSONObject(1).getBoolean("completed"))
        assertEquals(190.0, sets.getJSONObject(1).getDouble("weight"), 0.001)
        // Warm-up ahead of it keeps what it had.
        assertEquals(135.0, sets.getJSONObject(0).getDouble("weight"), 0.001)
    }

    @Test
    fun `a set logged twice is a correction, not a second set`() {
        val w = Session.parse(body)!!
        val once = Session.applyLogged(w, "e1", "s2", 190.0, 7)
        val twice = Session.applyLogged(once, "e1", "s2", 185.0, 8)
        assertEquals(2, twice.setsDone)
        assertEquals(185.0, twice.exercises[0].sets[1].weight, 0.001)
    }

    @Test
    fun `progress reads the way a glance wants it`() {
        assertEquals("1 of 4", Session.progress(Session.parse(body)))
        assertEquals("No session", Session.progress(null))
    }

    @Test
    fun `a weight has no pointless decimal`() {
        assertEquals("60 kg", Session.weightText(60.0, "kg"))
        assertEquals("62.5 kg", Session.weightText(62.5, "kg"))
        assertEquals("Bodyweight", Session.weightText(0.0, "lbs"))
    }

    @Test
    fun `the countdown reads as a clock`() {
        assertEquals("1:30", Session.clock(90))
        assertEquals("0:05", Session.clock(5))
        assertEquals("0:00", Session.clock(-3))
    }

    @Test
    fun `rest follows the account, and falls back to LiftTrace's own default`() {
        assertEquals(120, Session.restSeconds(JSONObject("""{"restDuration":120}""")))
        assertEquals(120, Session.restSeconds(JSONObject("""{"restDuration":"120"}""")))
        assertEquals(90, Session.restSeconds(null))
        assertEquals(90, Session.restSeconds(JSONObject("""{"restDuration":0}""")))
        assertTrue(Session.restAutoStart(null))
        assertFalse(Session.restAutoStart(JSONObject("""{"restAutoStart":false}""")))
    }

    @Test
    fun `pounds is the default, and the step is the smallest plate pair`() {
        assertEquals("lbs", Session.weightUnit(null))
        assertEquals("lbs", Session.weightUnit(JSONObject("""{"weightUnit":"lbs"}""")))
        assertEquals("kg", Session.weightUnit(JSONObject("""{"weightUnit":"kg"}""")))
        assertEquals(5.0, Session.weightStep("lbs"), 0.001)
        assertEquals(2.5, Session.weightStep("kg"), 0.001)
    }
}
