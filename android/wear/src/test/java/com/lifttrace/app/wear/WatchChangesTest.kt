package com.lifttrace.app.wear

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The watch's save says which sets it changed, so the server keeps its own of
 * the rest: a set the phone changed between the watch reading the day and
 * saving it isn't put back by the copy the watch read.
 */
class WatchChangesTest {
    private fun change(ex: String, set: String) = Session.Change(ex, set, 100.0, 5, null, null, 0, true, false)

    @Test fun eachChangedSetOnceUnderItsExercise() {
        val out = Session.changedUuids(listOf(change("e1", "s1"), change("e1", "s1"), change("e1", "s2"), change("e2", "t1")))
        assertEquals(0, out.getJSONArray("exercises").length())
        val sets = out.getJSONObject("sets")
        assertEquals(listOf("s1", "s2"), (0 until sets.getJSONArray("e1").length()).map { sets.getJSONArray("e1").getString(it) })
        assertEquals("t1", sets.getJSONArray("e2").getString(0))
    }

    @Test fun nothingChangedSaysSo() {
        val out = Session.changedUuids(emptyList())
        assertEquals(0, out.getJSONObject("sets").length())
    }
}
