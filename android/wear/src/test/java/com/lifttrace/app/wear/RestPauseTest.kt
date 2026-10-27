package com.lifttrace.app.wear

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A rest record from the phone, paused or not, and from a phone that has
 * never heard of pausing (Pairing.restFrom).
 */
class RestPauseTest {
    private val now = 1_791_700_000_000L

    @Test fun aPausedRestIsHeldWithWhatWasLeft() {
        val rest = Pairing.restFrom(cleared = true, paused = true, leftMs = 72_000L, label = "Bench Press", total = 90, endsAt = 0L, now = now)!!
        assertTrue(rest.paused)
        assertEquals(72_000L, rest.pausedLeftMs)
        assertEquals(0L, rest.endsAt)
        assertEquals(90, rest.total)
    }

    @Test fun aPausedRestWithNothingLeftIsNone() {
        assertNull(Pairing.restFrom(cleared = true, paused = true, leftMs = 0L, label = "", total = 90, endsAt = 0L, now = now))
    }

    @Test fun aPhoneFromBeforePausingReadsAsAlways() {
        val running = Pairing.restFrom(cleared = false, paused = false, leftMs = 0L, label = "Squat", total = 120, endsAt = now + 60_000L, now = now)!!
        assertFalse(running.paused)
        assertEquals(now + 60_000L, running.endsAt)
        assertNull(Pairing.restFrom(cleared = true, paused = false, leftMs = 0L, label = "", total = 0, endsAt = 0L, now = now))
        assertNull(Pairing.restFrom(cleared = false, paused = false, leftMs = 0L, label = "", total = 90, endsAt = now - 1L, now = now))
    }

    @Test fun aRunningRestIsNotPaused() {
        assertFalse(Pairing.Timer("Bench Press", 90, now + 1L).paused)
        assertTrue(Pairing.Timer("Bench Press", 90, 0L, 5_000L).paused)
    }
}
