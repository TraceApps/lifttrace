package com.lifttrace.app;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

/** Numbers as the plugin bridge hands them over: Integer, Long or Double. */
public class JsNumberTest {
    @Test
    public void aTimeInMillisecondsArrivesWhole() {
        // What JSON makes of Date.now(): too big for an int, so a Long.
        Object startTime = Long.valueOf(1791700000123L);
        assertEquals(1791700000123L, JsNumber.whole(startTime));
        assertEquals(1791700000123d, JsNumber.num(startTime), 0d);
    }

    @Test
    public void smallAndFractionalNumbersToo() {
        assertEquals(90L, JsNumber.whole(Integer.valueOf(90)));
        assertEquals(12.5d, JsNumber.num(Double.valueOf(12.5)), 0d);
    }

    @Test
    public void nothingThereIsNought() {
        assertEquals(0L, JsNumber.whole(null));
        assertEquals(0d, JsNumber.num("12"), 0d);
    }
}
