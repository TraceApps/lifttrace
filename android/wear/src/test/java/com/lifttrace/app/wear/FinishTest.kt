package com.lifttrace.app.wear

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Finishing a workout on the watch, the way the phone finishes one: by
 * itself when the last set is ticked off, or from Finish Workout with sets
 * left (asked first, saying how many), and the summary it shows after.
 */
class FinishTest {

    private val day = """
        {"workout":{"id":7,"date":"2026-10-21","name":"Push","notes":"felt strong","duration_min":26,"completed":0,
         "exercises":[
          {"uuid":"e1","exercise_id":11,"exercise_name":"Bench Press","sets":[
            {"uuid":"s1","reps":10,"weight":95,"completed":true,"warmup":true},
            {"uuid":"s2","reps":5,"weight":185,"completed":true},
            {"uuid":"s3","reps":5,"weight":185,"completed":false}
          ]},
          {"uuid":"e2","exercise_id":12,"exercise_name":"Overhead Press","sets":[
            {"uuid":"s4","reps":6,"weight":105,"completed":false}
          ]}
        ]}}
    """.trimIndent()

    private fun parse(body: String = day) = Session.parse(body)!!

    private fun tick(w: Session.Workout, ex: String, set: String): Session.Change {
        val exercise = w.exercise(ex)!!
        return Session.suggest(exercise, exercise.sets.indexOfFirst { it.uuid == set }).copy(completed = true)
    }

    private fun logged(w: Session.Workout, ex: String, set: String) = Session.applyChange(w, tick(w, ex, set))

    // ── By itself ────────────────────────────────────────────────────────

    @Test
    fun `ticking off the last set finishes the workout`() {
        val w = logged(parse(), "e1", "s3")
        assertTrue(Session.finishes(w, tick(w, "e2", "s4")))
    }

    @Test
    fun `a set that isn't the last one doesn't`() {
        val w = parse()
        assertFalse(Session.finishes(w, tick(w, "e1", "s3")))
    }

    @Test
    fun `the phone's rule - every exercise has a set and every set is done`() {
        val w = logged(logged(parse(), "e1", "s3"), "e2", "s4")
        assertTrue(Session.allDone(w))
        // An exercise with no sets keeps it open, as on the phone.
        val empty = parse("""
            {"workout":{"id":8,"date":"2026-10-21","name":"Push","exercises":[
              {"uuid":"e1","exercise_name":"Bench Press","sets":[{"uuid":"s1","reps":5,"weight":185,"completed":true}]},
              {"uuid":"e2","exercise_name":"Overhead Press","sets":[]}
            ]}}
        """.trimIndent())
        assertTrue(empty.finished)
        assertFalse(Session.allDone(empty))
        assertFalse(Session.allDone(parse("""{"workout":{"id":1,"date":"2026-10-21","exercises":[]}}""")))
        assertFalse(Session.allDone(null))
    }

    @Test
    fun `a warm-up left undone keeps it open`() {
        var w = parse()
        w = Session.applyChange(w, tick(w, "e1", "s1").copy(completed = false))
        w = logged(w, "e1", "s3")
        assertFalse(Session.finishes(w, tick(w, "e2", "s4")))
    }

    @Test
    fun `correcting a set already done or reopening one doesn't finish it`() {
        val w = logged(logged(parse(), "e1", "s3"), "e2", "s4")
        val again = w.copy(completed = false)
        assertFalse(Session.finishes(again, tick(again, "e2", "s4")))
        assertFalse(Session.finishes(again, tick(again, "e2", "s4").copy(completed = false)))
    }

    @Test
    fun `a workout already finished isn't finished twice`() {
        val w = logged(parse(day.replace("\"completed\":0,", "\"completed\":1,")), "e1", "s3")
        assertTrue(w.completed)
        assertFalse(Session.finishes(w, tick(w, "e2", "s4")))
    }

    @Test
    fun `a set added and logged as the last one finishes it`() {
        val w = logged(logged(parse(), "e1", "s3"), "e2", "s4").copy(completed = false)
        // Every set done but not finished (finished on an older watch, say):
        // one more set added and logged is the last one ticked.
        val added = Session.addition(w.exercise("e2")!!).copy(completed = true)
        assertTrue(Session.finishes(w, added))
    }

    @Test
    fun `a change for an exercise that isn't there finishes nothing`() {
        val w = logged(parse(), "e1", "s3")
        assertFalse(Session.finishes(w, tick(w, "e2", "s4").copy(exerciseUuid = "gone")))
    }

    // ── Finish Workout ───────────────────────────────────────────────────

    @Test
    fun `finishing early says how many sets are left, warm-ups included`() {
        val w = parse()
        assertEquals(2, Session.setsLeft(w))
        assertEquals(1, Session.setsLeft(logged(w, "e1", "s3")))
        val warm = Session.applyChange(w, tick(w, "e1", "s1").copy(completed = false))
        assertEquals(3, Session.setsLeft(warm))
        assertEquals(0, Session.setsLeft(null))
    }

    @Test
    fun `Finish Workout is there once a set is done, as on the phone`() {
        val none = parse(day.replace("\"completed\":true", "\"completed\":false"))
        assertEquals(0, none.setsDone)
        assertFalse(Session.canFinish(none))
        assertTrue(Session.canFinish(parse()))
        assertFalse(Session.canFinish(Session.finish(parse(), null)))
        assertFalse(Session.canFinish(null))
    }

    @Test
    fun `finishing marks it done with the clock's length, and keeps the rest`() {
        val done = Session.finish(parse(), 47.3)
        assertTrue(done.completed)
        assertEquals(1, done.raw.getInt("completed"))
        assertEquals(47.3, done.raw.getDouble("duration_min"), 0.001)
        assertEquals("felt strong", done.raw.getString("notes"))
        assertEquals("Push", done.raw.getString("name"))
        // What came in is left alone.
        assertEquals(0, parse().raw.getInt("completed"))
    }

    @Test
    fun `with no clock running the length already written stays`() {
        val done = Session.finish(parse(), null)
        assertEquals(26.0, done.raw.getDouble("duration_min"), 0.001)
        assertEquals(26.0, done.minutes!!, 0.001)
    }

    // ── What goes up ─────────────────────────────────────────────────────

    @Test
    fun `a save says which of the session's own fields it changed, and no more`() {
        val set = Pairing.Op("2026-10-21", 7L, Session.Change("e1", "s3", 185.0, 5, null, null, 0, true, false))
        assertEquals(emptyList<String>(), Pairing.changedFields(listOf(set)))
        val finished = Pairing.Op("2026-10-21", 7L, minutes = 47.3, finished = true)
        assertEquals(listOf("completed", "duration_min"), Pairing.changedFields(listOf(set, finished)))
        val noClock = Pairing.Op("2026-10-21", 7L, minutes = null, finished = true)
        assertEquals(listOf("completed"), Pairing.changedFields(listOf(set, noClock)))
        val stopped = Pairing.Op("2026-10-21", 7L, minutes = 30.0)
        assertEquals(listOf("duration_min"), Pairing.changedFields(listOf(stopped)))
    }

    @Test
    fun `what's still waiting keeps the workout finished on screen`() {
        // The server refused the send for now, so it still says not finished:
        // the screen keeps what the watch did rather than offering Finish
        // Workout again.
        val w = parse()
        val set = Pairing.Op("2026-10-21", 7L, tick(w, "e1", "s3"))
        val over = Pairing.Op("2026-10-21", 7L, minutes = 47.3, finished = true)
        val shown = Pairing.replay(w, listOf(set, over))
        assertTrue(shown.completed)
        assertEquals(47.3, shown.minutes!!, 0.001)
        assertTrue(shown.set("e1", "s3")!!.completed)
        val stopped = Pairing.replay(w, listOf(Pairing.Op("2026-10-21", 7L, minutes = 30.0)))
        assertFalse(stopped.completed)
        assertEquals(30.0, stopped.minutes!!, 0.001)
        assertEquals(w, Pairing.replay(w, emptyList()))
    }

    @Test
    fun `finishing offline survives the outbox`() {
        val op = Pairing.Op("2026-10-21", 7L, minutes = 47.3, finished = true, seq = 4L)
        val back = Pairing.Op.from(op.toJson())
        assertTrue(back.finished)
        assertEquals(47.3, back.minutes!!, 0.001)
        assertEquals("finished", back.key)
    }

    // ── The summary ──────────────────────────────────────────────────────

    @Test
    fun `the summary counts working sets and their volume, as the phone's does`() {
        val w = Session.finish(logged(parse(), "e1", "s3"), 47.3)
        val s = Session.summary(w)
        // The warm-up isn't a working set and lifts nothing.
        assertEquals(2, s.sets)
        assertEquals(185L * 5 * 2, s.volume)
        assertEquals(47.3, s.minutes!!, 0.001)
    }

    @Test
    fun `volume counts both sides the way the phone does`() {
        val w = parse("""
            {"workout":{"id":2,"date":"2026-10-21","name":"Arms","exercises":[
              {"uuid":"a","exercise_name":"Dumbbell Curl","load_type":"paired","sets":[
                {"uuid":"a1","reps":10,"weight":30,"completed":true}]},
              {"uuid":"b","exercise_name":"Split Squat","load_type":"unilateral","sets":[
                {"uuid":"b1","reps_l":8,"reps_r":6,"weight":40,"completed":true},
                {"uuid":"b2","reps":5,"weight":40,"completed":true}]},
              {"uuid":"c","exercise_name":"Farmer Carry","set_type":"time","sets":[
                {"uuid":"c1","duration_sec":60,"reps":3,"weight":100,"completed":true}]},
              {"uuid":"d","exercise_name":"Cable Row","_library_load_type":"paired","sets":[
                {"uuid":"d1","reps":10,"weight":50,"completed":true},
                {"uuid":"d2","reps":10,"weight":50,"completed":false}]},
              {"uuid":"e","exercise_name":"Hang","sets":[
                {"uuid":"e1","duration_sec":30,"weight":20,"reps":1,"completed":true}]}
            ]}}
        """.trimIndent())
        // 30x10x2 + 40x(8+6) + 40x5x2, a hold lifts nothing, and like the
        // phone's summary the library's load type isn't read: 50x10 once.
        assertEquals(600L + 560 + 400 + 500, Session.summary(w).volume)
        assertNull(Session.summary(w).minutes)
    }

    @Test
    fun `how long reads the way the phone's summary reads it`() {
        assertEquals("45m", Session.duration(45.0))
        assertEquals("1h 5m", Session.duration(65.0))
        assertEquals("43m", Session.duration(42.5))
        assertEquals("60m", Session.duration(59.6))
        assertEquals("2h 0m", Session.duration(120.0))
        assertNull(Session.duration(null))
        assertNull(Session.duration(0.0))
    }

    @Test
    fun `volume reads the way the phone's summary reads it`() {
        // (v / 1000).toFixed(1) in JavaScript, exactly.
        assertEquals("950", Session.volumeText(950))
        assertEquals("1.0k", Session.volumeText(1000))
        assertEquals("12.3k", Session.volumeText(12340))
        assertEquals("12.3k", Session.volumeText(12350))
        assertEquals("1.1k", Session.volumeText(1150))
        assertEquals("2.3k", Session.volumeText(2250))
        assertEquals("100.0k", Session.volumeText(99950))
    }
}
