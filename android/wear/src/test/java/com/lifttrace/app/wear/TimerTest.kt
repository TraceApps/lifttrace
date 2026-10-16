package com.lifttrace.app.wear

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The phone once told the watch its workout timer started at 0 (its plugin
 * dropped any number in milliseconds), so both counted from 1970: 497712
 * hours. A timer kept like that is no timer.
 */
class TimerTest {
    private fun running(start: Long) = Pairing.SessionTimer("2026-10-11", start, 0.0, false, 0.0)
    private fun paused(sec: Double) = Pairing.SessionTimer("2026-10-11", 0L, 0.0, true, sec)

    @Test fun aTimerStartedAtZeroIsNoTimer() {
        assertFalse(Pairing.sane(running(0L)))
    }

    @Test fun oneStartedTodayIsKept() {
        assertTrue(Pairing.sane(running(1_791_700_000_000L)))
    }

    @Test fun oneResumedAfterCountingFrom1970IsNoTimer() {
        assertFalse(Pairing.sane(Pairing.SessionTimer("2026-10-11", 1_791_700_000_000L, 1_791_700_000.0, false, 0.0)))
    }

    @Test fun aPausedOneKeepsWhatItRan() {
        assertTrue(Pairing.sane(paused(3_600.0)))
        // Paused after counting from 1970.
        assertFalse(Pairing.sane(paused(1_791_700_000.0)))
    }
}
