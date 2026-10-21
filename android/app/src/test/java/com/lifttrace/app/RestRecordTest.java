package com.lifttrace.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * The rest as the notification holds it: what it shows (running, paused or
 * nothing), what its buttons do to it, and what it makes of the watch.
 */
public class RestRecordTest {
    private static final long T0 = 1_791_700_000_000L;

    private static RestRecord running() {
        RestRecord r = new RestRecord();
        r.active = true;
        r.endsAt = T0 + 90_000L;
        r.total = 90;
        r.startedAt = T0;
        r.at = T0;
        r.label = "Bench Press";
        r.title = "Set 3 of 4 · Bench Press";
        r.pausedText = "Rest paused, {time} left";
        return r;
    }

    @Test
    public void whatItShows() {
        RestRecord r = running();
        assertEquals(RestRecord.Kind.RUNNING, r.kind(T0 + 10_000L));
        assertEquals(RestRecord.Kind.NONE, r.kind(T0 + 90_000L));
        r.pauseAt(T0 + 18_000L);
        assertEquals(RestRecord.Kind.PAUSED, r.kind(T0 + 999_000L));
        r.active = false;
        assertEquals(RestRecord.Kind.NONE, r.kind(T0));
    }

    @Test
    public void pauseHoldsWhatWasLeftAndResumeCountsOnFromNow() {
        RestRecord r = running();
        assertTrue(r.pauseAt(T0 + 18_000L));
        assertEquals(72_000L, r.left(T0 + 500_000L));
        assertEquals("Rest paused, 1:12 left", r.pausedLine(T0 + 500_000L));
        assertEquals(T0 + 18_000L, r.at);
        assertFalse("already paused", r.pauseAt(T0 + 20_000L));

        assertTrue(r.resumeAt(T0 + 300_000L));
        assertEquals(T0 + 372_000L, r.endsAt);
        assertEquals(RestRecord.Kind.RUNNING, r.kind(T0 + 300_000L));
        assertEquals(200, r.progress(T0 + 300_000L));
        assertFalse("already running", r.resumeAt(T0 + 300_001L));
    }

    @Test
    public void addingThirtySecondsCountingOrPaused() {
        RestRecord r = running();
        assertTrue(r.extendAt(30, T0 + 1_000L));
        assertEquals(T0 + 120_000L, r.endsAt);
        assertEquals(120, r.total);
        r.pauseAt(T0 + 60_000L);
        assertTrue(r.extendAt(30, T0 + 70_000L));
        assertEquals(90_000L, r.leftMs);
        assertFalse("nothing to add to once it is over", running().extendAt(30, T0 + 95_000L));
    }

    @Test
    public void theBarTicksOnlyWhileCountingAndOnScreen() {
        RestRecord r = running();
        assertTrue(r.wantsTicks(true, T0 + 1_000L));
        assertFalse("screen off", r.wantsTicks(false, T0 + 1_000L));
        r.dismissedFor = r.startedAt;
        assertFalse("swiped away", r.wantsTicks(true, T0 + 1_000L));
        RestRecord p = running();
        p.pauseAt(T0 + 1_000L);
        assertFalse("paused: nothing moves", p.wantsTicks(true, T0 + 2_000L));
    }

    @Test
    public void aSwipeAwayHoldsOnlyForItsOwnRest() {
        RestRecord r = running();
        r.dismissedFor = T0;
        assertTrue(r.dismissed());
        r.startedAt = T0 + 200_000L;
        assertFalse(r.dismissed());
    }

    @Test
    public void theWatchPausingIsTakenWhenItIsTheLaterWord() {
        RestRecord r = running();
        assertTrue(r.adoptWire(true, true, 40_000L, 0L, 90, "Bench Press", T0 + 50_000L, T0 + 50_000L));
        assertEquals(RestRecord.Kind.PAUSED, r.kind(T0 + 60_000L));
        assertEquals(40_000L, r.leftMs);
        assertEquals("the next set this phone had is kept", "Set 3 of 4 · Bench Press", r.title);
        assertFalse("an older word is ignored", r.adoptWire(false, false, 0L, T0 + 80_000L, 90, "Bench Press", T0 + 40_000L, T0 + 60_000L));
        assertFalse("its own write coming back changes nothing", r.adoptWire(true, true, 40_000L, 0L, 90, "Bench Press", r.at, T0 + 60_000L));
    }

    @Test
    public void whatTheWatchSaysMeansTheWatchHasIt() {
        RestRecord r = running();
        assertFalse(r.onWatch);
        r.adoptWire(true, true, 40_000L, 0L, 90, "Bench Press", T0 + 50_000L, T0 + 50_000L);
        assertTrue(r.onWatch);
    }

    @Test
    public void aWatchFromBeforePausingStillReads() {
        // Running and skipped, as an old watch says them (no paused at all).
        RestRecord r = running();
        assertTrue(r.adoptWire(false, false, 0L, T0 + 150_000L, 120, "Bench Press", T0 + 1L, T0 + 10_000L));
        assertEquals(T0 + 150_000L, r.endsAt);
        assertTrue(r.adoptWire(true, false, 0L, 0L, 0, "", T0 + 2L, T0 + 10_000L));
        assertEquals(RestRecord.Kind.NONE, r.kind(T0 + 10_000L));
    }

    @Test
    public void aRestStartedOnTheWatchWithNoneHereIsLeftToTheApp() {
        RestRecord r = new RestRecord();
        assertFalse(r.adoptWire(false, false, 0L, T0 + 90_000L, 90, "Squat", T0 + 5L, T0));
        assertEquals(RestRecord.Kind.NONE, r.kind(T0));
    }

    @Test
    public void anotherLiftsRestDropsTheNextSetWords() {
        RestRecord r = running();
        r.text = "150 lbs × 8 · Last time 145 × 8";
        assertTrue(r.adoptWire(false, false, 0L, T0 + 60_000L, 60, "Squat", T0 + 5L, T0));
        assertEquals("Squat", r.titleOr());
        assertEquals("", r.text);
    }

    @Test
    public void clockReadsLikeTheRestBar() {
        assertEquals("1:12", RestRecord.clock(72_000L));
        assertEquals("the rest bar's own rounding", "1:11", RestRecord.clock(71_999L));
        assertEquals("0:00", RestRecord.clock(0L));
        assertEquals("10:00", RestRecord.clock(600_000L));
    }
}
