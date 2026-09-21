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
        {"workout":{"id":7,"date":"2026-09-21","name":"Push A","notes":"felt strong","duration_min":42,"completed":0,
         "exercises":[
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

    private val plank = """
        {"workout":{"id":9,"date":"2026-09-21","name":"Core","exercises":[
          {"uuid":"e9","exercise_id":7,"exercise_name":"Plank","set_type":"time","sets":[
            {"uuid":"p1","duration_sec":60,"completed":false},
            {"uuid":"p2","duration_sec":60,"completed":false}
          ]}
        ]}}
    """.trimIndent()

    private val split = """
        {"workout":{"id":3,"date":"2026-09-21","name":"Legs","exercises":[
          {"uuid":"e3","exercise_id":21,"exercise_name":"Split Squat","load_type":"unilateral","sets":[
            {"uuid":"t1","reps_l":8,"reps_r":8,"weight":40,"completed":false}
          ]}
        ]}}
    """.trimIndent()

    @Test
    fun `reads the day the server sent`() {
        val w = Session.parse(body)!!
        assertEquals(7L, w.id)
        assertEquals("Push A", w.name)
        assertFalse(w.completed)
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
    fun `a session deleted on the phone is not a session`() {
        // Asking for it by id still answers, so that an undo on the phone can
        // put it back. The watch must not treat that as something to log into.
        val deleted = body.replace("\"name\":\"Push A\"", "\"name\":\"Push A\",\"deleted_at\":\"2026-09-21 11:37:31\"")
        assertNull(Session.parse(deleted))
    }

    @Test
    fun `a coach's notes are not kept on the watch`() {
        val withNotes = body.replace(
            "\"name\":\"Push A\"",
            "\"name\":\"Push A\",\"feedback\":[{\"id\":1,\"note\":\"keep your elbows in\"}]",
        )
        val w = Session.parse(withNotes)!!
        assertFalse(w.raw.has("feedback"))
        // And they are not sent back either, since the watch holds no copy.
        assertFalse(Session.upsert(w.raw, Session.suggest(w.exercises[0], 1)).has("feedback"))
    }

    @Test
    fun `a hold is read as a hold, and reps as reps`() {
        assertTrue(Session.parse(plank)!!.exercises[0].timed)
        assertFalse(Session.parse(body)!!.exercises[0].timed)
    }

    @Test
    fun `a set the phone records per side stays per side`() {
        val set = Session.parse(split)!!.exercises[0].sets[0]
        assertTrue(set.split)
        assertEquals(8, set.repsLeft)
        assertEquals(8, set.repsRight)
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
        for (e in w.exercises) {
            for ((i, _) in e.sets.withIndex()) {
                w = Session.applyChange(w, Session.suggest(w.exercise(e.uuid)!!, i).copy(completed = true))
            }
        }
        assertNull(Session.next(w))
        assertTrue(w.finished)
    }

    @Test
    fun `a planned set is offered as planned`() {
        val w = Session.parse(body)!!
        val draft = Session.suggest(w.exercises[0], 1)
        assertEquals(185.0, draft.weight, 0.001)
        assertEquals(8, draft.reps)
        assertEquals("s2", draft.setUuid)
    }

    @Test
    fun `a set with nothing on it borrows from the set before`() {
        val w = Session.parse(body)!!
        // s3 has no weight: the 185 from s2 is what you are most likely doing.
        val draft = Session.suggest(w.exercises[0], 2)
        assertEquals(185.0, draft.weight, 0.001)
        assertEquals(8, draft.reps)
    }

    @Test
    fun `a set added at the end carries the last one's numbers and its own id`() {
        val w = Session.parse(body)!!
        val added = Session.addition(w.exercises[1])
        assertEquals(95.0, added.weight, 0.001)
        assertEquals(10, added.reps)
        assertFalse(added.completed)
        assertTrue(added.setUuid.isNotBlank())
        assertFalse(added.setUuid == "s4")
        // It genuinely lands on the exercise rather than replacing anything.
        val after = Session.applyChange(w, added)
        assertEquals(2, after.exercise("e2")!!.total)
        assertEquals(5, after.setsTotal)
    }

    @Test
    fun `logging a set changes that set and nothing else`() {
        val w = Session.parse(body)!!
        val after = Session.applyChange(w, Session.suggest(w.exercises[0], 1).copy(weight = 190.0, reps = 7, completed = true))
        val set = after.exercises[0].sets[1]
        assertTrue(set.completed)
        assertEquals(190.0, set.weight, 0.001)
        assertEquals(7, set.reps)
        assertFalse(after.exercises[1].sets[0].completed)
        assertEquals(2, after.setsDone)
    }

    @Test
    fun `a set can be put back to not done`() {
        val w = Session.parse(body)!!
        val reopened = Session.applyChange(w, Session.suggest(w.exercises[0], 0).copy(completed = false))
        assertFalse(reopened.exercises[0].sets[0].completed)
        assertEquals(0, reopened.setsDone)
    }

    @Test
    fun `what goes up keeps everything the watch knows nothing about`() {
        val w = Session.parse(body)!!
        val sent = Session.upsert(w.raw, Session.suggest(w.exercises[0], 1).copy(weight = 190.0, reps = 7, completed = true))
        assertEquals(7, sent.getInt("id"))
        assertEquals("felt strong", sent.getString("notes"))
        assertEquals(42, sent.getInt("duration_min"))
        val sets = sent.getJSONArray("exercises").getJSONObject(0).getJSONArray("sets")
        assertTrue(sets.getJSONObject(1).getBoolean("completed"))
        assertEquals(190.0, sets.getJSONObject(1).getDouble("weight"), 0.001)
        // The warm-up ahead of it keeps what it had, warm-up marking included.
        assertEquals(135.0, sets.getJSONObject(0).getDouble("weight"), 0.001)
        assertTrue(sets.getJSONObject(0).getBoolean("warmup"))
    }

    @Test
    fun `a change replays onto whatever the server now holds`() {
        // The phone renamed the session and logged another exercise's set
        // while the watch was in a dead zone.
        val onServer = Session.parse(
            """
            {"workout":{"id":7,"date":"2026-09-21","name":"Push A (evening)","notes":"phone note","exercises":[
              {"uuid":"e1","exercise_id":11,"exercise_name":"Bench Press","sets":[
                {"uuid":"s1","reps":10,"weight":135,"completed":true,"warmup":true},
                {"uuid":"s2","reps":8,"weight":185,"completed":false}
              ]},
              {"uuid":"e2","exercise_id":12,"exercise_name":"Overhead Press","sets":[
                {"uuid":"s4","reps":10,"weight":95,"completed":true}
              ]}
            ]}}
            """.trimIndent()
        )!!
        val queued = Session.Change("e1", "s2", 190.0, 7, null, null, 0, true, false)
        val sent = Session.upsert(onServer.raw, queued)
        assertEquals("Push A (evening)", sent.getString("name"))
        assertEquals("phone note", sent.getString("notes"))
        val bench = sent.getJSONArray("exercises").getJSONObject(0).getJSONArray("sets")
        assertTrue(bench.getJSONObject(1).getBoolean("completed"))
        assertEquals(7, bench.getJSONObject(1).getInt("reps"))
        // What the phone did is still there.
        assertTrue(sent.getJSONArray("exercises").getJSONObject(1).getJSONArray("sets").getJSONObject(0).getBoolean("completed"))
    }

    @Test
    fun `a set that is not recorded per side never grows the fields`() {
        val w = Session.parse(body)!!
        val sent = Session.upsert(w.raw, Session.suggest(w.exercises[0], 1).copy(completed = true))
        val set = sent.getJSONArray("exercises").getJSONObject(0).getJSONArray("sets").getJSONObject(1)
        assertFalse(set.has("reps_l"))
        assertFalse(set.has("reps_r"))
    }

    @Test
    fun `a per-side set is written back per side`() {
        val w = Session.parse(split)!!
        val draft = Session.suggest(w.exercises[0], 0)
        assertEquals(8, draft.repsLeft)
        val sent = Session.upsert(w.raw, draft.copy(repsLeft = 7, completed = true))
        val set = sent.getJSONArray("exercises").getJSONObject(0).getJSONArray("sets").getJSONObject(0)
        assertEquals(7, set.getInt("reps_l"))
        assertEquals(8, set.getInt("reps_r"))
    }

    @Test
    fun `a hold is written back as seconds`() {
        val w = Session.parse(plank)!!
        val sent = Session.upsert(w.raw, Session.suggest(w.exercises[0], 0).copy(durationSec = 75, completed = true))
        val set = sent.getJSONArray("exercises").getJSONObject(0).getJSONArray("sets").getJSONObject(0)
        assertEquals(75, set.getInt("duration_sec"))
        assertTrue(set.getBoolean("completed"))
    }

    private val superset = """
        {"workout":{"id":5,"date":"2026-09-21","name":"Arms","exercises":[
          {"uuid":"a1","exercise_id":31,"exercise_name":"Curl","superset_id":"g1","superset_size":2,"rest_sec":120,"sets":[
            {"uuid":"c1","reps":12,"weight":30,"completed":false},
            {"uuid":"c2","reps":12,"weight":30,"completed":false}
          ]},
          {"uuid":"a2","exercise_id":32,"exercise_name":"Pushdown","superset_id":"g1","superset_size":2,"sets":[
            {"uuid":"d1","reps":12,"weight":40,"completed":false},
            {"uuid":"d2","reps":12,"weight":40,"completed":false}
          ]},
          {"uuid":"a3","exercise_id":33,"exercise_name":"Hammer Curl","sets":[
            {"uuid":"h1","reps":10,"weight":25,"completed":false}
          ]}
        ]}}
    """.trimIndent()

    private fun log(w: Session.Workout, ex: String, set: String): Session.Workout {
        val exercise = w.exercise(ex)!!
        val index = exercise.sets.indexOfFirst { it.uuid == set }
        return Session.applyChange(w, Session.suggest(exercise, index).copy(completed = true))
    }

    @Test
    fun `a superset alternates rather than running one exercise dry`() {
        var w = Session.parse(superset)!!
        assertEquals("c1", Session.next(w)!!.set.uuid)
        w = log(w, "a1", "c1")
        assertEquals("d1", Session.next(w)!!.set.uuid)
        w = log(w, "a2", "d1")
        assertEquals("c2", Session.next(w)!!.set.uuid)
        w = log(w, "a1", "c2")
        assertEquals("d2", Session.next(w)!!.set.uuid)
        w = log(w, "a2", "d2")
        // The pairing is done, so the session moves on to what follows it.
        assertEquals("h1", Session.next(w)!!.set.uuid)
    }

    @Test
    fun `each pairing gets a letter and each exercise its place in it`() {
        val w = Session.parse(superset)!!
        assertEquals("A1", Session.supersetLabel(w, w.exercise("a1")!!))
        assertEquals("A2", Session.supersetLabel(w, w.exercise("a2")!!))
        // The exercise on its own is not in a pairing and says nothing.
        assertNull(Session.supersetLabel(w, w.exercise("a3")!!))
        assertEquals("Pushdown", Session.partners(w, w.exercise("a1")!!).joinToString { it.name })
        assertTrue(Session.partners(w, w.exercise("a3")!!).isEmpty())
    }

    @Test
    fun `a second pairing is the next letter along`() {
        val two = """
            {"workout":{"id":6,"date":"2026-09-21","name":"Arms","exercises":[
              {"uuid":"a1","exercise_id":31,"exercise_name":"Curl","superset_id":"g1","superset_size":2,"sets":[
                {"uuid":"c1","reps":12,"weight":30,"completed":false}]},
              {"uuid":"a2","exercise_id":32,"exercise_name":"Pushdown","superset_id":"g1","superset_size":2,"sets":[
                {"uuid":"d1","reps":12,"weight":40,"completed":false}]},
              {"uuid":"a3","exercise_id":33,"exercise_name":"Hammer Curl","superset_id":"g2","superset_size":2,"sets":[
                {"uuid":"h1","reps":10,"weight":25,"completed":false}]},
              {"uuid":"a4","exercise_id":34,"exercise_name":"Skullcrusher","superset_id":"g2","superset_size":2,"sets":[
                {"uuid":"k1","reps":10,"weight":45,"completed":false}]}
            ]}}
        """.trimIndent()
        val w = Session.parse(two)!!
        assertEquals("A1", Session.supersetLabel(w, w.exercise("a1")!!))
        assertEquals("A2", Session.supersetLabel(w, w.exercise("a2")!!))
        assertEquals("B1", Session.supersetLabel(w, w.exercise("a3")!!))
        assertEquals("B2", Session.supersetLabel(w, w.exercise("a4")!!))
        // And the pairings alternate within themselves, not across.
        assertEquals("c1", Session.next(w)!!.set.uuid)
        val after = Session.applyChange(w, Session.suggest(w.exercise("a1")!!, 0).copy(completed = true))
        assertEquals("d1", Session.next(after)!!.set.uuid)
    }

    @Test
    fun `a superset rests after the round, not between the two exercises`() {
        var w = Session.parse(superset)!!
        w = log(w, "a1", "c1")
        assertFalse(Session.shouldRest(w, "a1", "c1"))
        w = log(w, "a2", "d1")
        assertTrue(Session.shouldRest(w, "a2", "d1"))
    }

    @Test
    fun `a warm-up rests after nothing`() {
        val w = log(Session.parse(body)!!, "e1", "s1")
        assertFalse(Session.shouldRest(w, "e1", "s1"))
        val working = log(w, "e1", "s2")
        assertTrue(Session.shouldRest(working, "e1", "s2"))
    }

    @Test
    fun `the next round starts back at the top of the pairing`() {
        val w = log(Session.parse(superset)!!, "a2", "d1")
        assertEquals("Curl", Session.upNext(w, "a2")!!.name)
        assertEquals("Bench Press", Session.upNext(Session.parse(body)!!, "e1")!!.name)
    }

    @Test
    fun `a plan's own rest beats the account's`() {
        val w = Session.parse(superset)!!
        val settings = JSONObject("""{"restDuration":60}""")
        assertEquals(120, Session.restFor(w, "a1", settings))
        // The pairing's rest is the one at the top of it, whichever half you
        // just finished.
        assertEquals(120, Session.restFor(w, "a2", settings))
        assertEquals(60, Session.restFor(w, "a3", settings))
    }

    @Test
    fun `the rest timer stays off until the account turns it on`() {
        assertFalse(Session.restEnabled(null))
        assertFalse(Session.restEnabled(JSONObject("{}")))
        assertTrue(Session.restEnabled(JSONObject("""{"restTimerEnabled":true}""")))
    }

    @Test
    fun `last time is the best working set of the last session that had one`() {
        val recent = """
            [
              {"date":"2026-09-21","exercises":[{"exercise_id":11,"exercise_name":"Bench Press","sets":[
                {"uuid":"x","reps":3,"weight":225,"completed":true}]}]},
              {"date":"2026-09-18","exercises":[
                {"exercise_id":11,"exercise_name":"Bench Press","sets":[
                  {"uuid":"a","reps":10,"weight":135,"completed":true,"warmup":true},
                  {"uuid":"b","reps":8,"weight":185,"completed":true},
                  {"uuid":"c","reps":6,"weight":195,"completed":true},
                  {"uuid":"d","reps":6,"weight":205,"completed":false}]},
                {"exercise_id":7,"exercise_name":"Plank","set_type":"time","sets":[
                  {"uuid":"e","duration_sec":45,"completed":true},
                  {"uuid":"f","duration_sec":75,"completed":true}]}]},
              {"date":"2026-09-15","exercises":[{"exercise_id":11,"exercise_name":"Bench Press","sets":[
                {"uuid":"g","reps":8,"weight":175,"completed":true}]}]}
            ]
        """.trimIndent()
        val lines = Session.lastTimes(recent, "2026-09-21", "lbs")
        // Today is not last time, a warm-up is not the answer, and neither is
        // a set that was planned but never done.
        assertEquals("195 lbs x 6 reps", lines[11])
        // A hold quotes the longest one.
        assertEquals("1:15", lines[7])
        assertNull(lines[99])
    }

    @Test
    fun `last time survives a session with nothing completed`() {
        val recent = """
            [{"date":"2026-09-20","exercises":[{"exercise_id":11,"sets":[{"uuid":"a","reps":8,"weight":185,"completed":false}]}]},
             {"date":"2026-09-18","exercises":[{"exercise_id":11,"sets":[{"uuid":"b","reps":8,"weight":180,"completed":true}]}]}]
        """.trimIndent()
        assertEquals("180 lbs x 8 reps", Session.lastTimes(recent, "2026-09-21", "lbs")[11])
    }

    @Test
    fun `progress reads the way a glance wants it`() {
        assertEquals("1 of 4", Session.progress(Session.parse(body)))
        assertEquals("No session", Session.progress(null))
    }

    @Test
    fun `a set on a list says what it is`() {
        val w = Session.parse(body)!!
        assertEquals("185 lbs x 8 reps", Session.setLine(w.exercises[0], w.exercises[0].sets[1], "lbs"))
        val p = Session.parse(plank)!!
        assertEquals("1:00", Session.setLine(p.exercises[0], p.exercises[0].sets[0], "lbs"))
        val s = Session.parse(split)!!
        assertEquals("40 lbs x 8 / 8", Session.setLine(s.exercises[0], s.exercises[0].sets[0], "lbs"))
    }

    @Test
    fun `a weight has no pointless decimal`() {
        assertEquals("60 kg", Session.weightText(60.0, "kg"))
        assertEquals("62.5 kg", Session.weightText(62.5, "kg"))
        assertEquals("Bodyweight", Session.weightText(0.0, "lbs"))
    }

    @Test
    fun `a session's length reads the way the phone writes it`() {
        assertEquals("0:42", Session.elapsed(42_000))
        assertEquals("42:10", Session.elapsed(2_530_000))
        assertEquals("1:04:12", Session.elapsed(3_852_000))
        assertEquals("0:00", Session.elapsed(-5))
    }

    @Test
    fun `the session timer keeps counting without the phone, and stops when paused`() {
        val now = 1_700_000_000_000L
        val running = Pairing.SessionTimer("2026-09-21", now - 60_000, 120.0, false, 0.0)
        // Two minutes on the clock when it started, one minute ago.
        assertEquals(180_000L, running.elapsedMs(now))
        // And it goes on counting on its own, with the phone nowhere near.
        assertEquals(240_000L, running.elapsedMs(now + 60_000))
        val paused = Pairing.SessionTimer("2026-09-21", now - 60_000, 120.0, true, 150.0)
        assertEquals(150_000L, paused.elapsedMs(now))
        assertEquals(150_000L, paused.elapsedMs(now + 60_000))
    }

    @Test
    fun `pausing holds the total, and resuming carries on from it`() {
        val now = 1_700_000_000_000L
        val running = Pairing.SessionTimer("2026-09-21", now - 600_000, 0.0, false, 0.0)
        val paused = running.pausedAt(now)
        assertTrue(paused.paused)
        assertEquals(600_000L, paused.elapsedMs(now + 120_000))
        val resumed = paused.resumedAt(now + 120_000)
        assertFalse(resumed.paused)
        // Ten minutes before the pause, one minute after resuming.
        assertEquals(660_000L, resumed.elapsedMs(now + 180_000))
    }

    @Test
    fun `the length written down is the length the phone would write`() {
        val now = 1_700_000_000_000L
        // 47 minutes and 18 seconds is 47.3 minutes, to a tenth, as on the phone.
        val timer = Pairing.SessionTimer("2026-09-21", now - 2_838_000, 0.0, false, 0.0)
        assertEquals(47.3, timer.minutes(now), 0.001)
    }

    @Test
    fun `a queued change survives being written down, whichever kind it is`() {
        val set = Pairing.Op(
            "2026-09-21", 7,
            change = Session.Change("e1", "s2", 190.0, 7, null, null, 0, true, false),
            seq = 12,
        )
        val back = Pairing.Op.from(set.toJson())
        assertEquals(set, back)
        assertEquals("s2", back.key)

        val length = Pairing.Op("2026-09-21", 7, minutes = 47.3, seq = 13)
        val lengthBack = Pairing.Op.from(length.toJson())
        assertEquals(length, lengthBack)
        assertEquals(47.3, lengthBack.minutes!!, 0.001)
        assertNull(lengthBack.change)
        assertEquals("duration", lengthBack.key)
        // The number each entry carries is what a send removes it by, so it
        // has to survive being written down.
        assertEquals(12L, back.seq)
        assertEquals(13L, lengthBack.seq)
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
