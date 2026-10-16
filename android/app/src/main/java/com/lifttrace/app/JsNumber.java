package com.lifttrace.app;

/**
 * A number from a plugin call, whatever size it arrived as. Capacitor's
 * PluginCall.getDouble answers with the default for a Long, and a time in
 * milliseconds always arrives as one (Android's JSON reader keeps a whole
 * number too big for an int as a Long): the workout timer's start read as 0,
 * so the phone and the watch counted from 1970, and every stamp as "now".
 */
public final class JsNumber {
    private JsNumber() {}

    public static double num(Object v) {
        return v instanceof Number ? ((Number) v).doubleValue() : 0d;
    }

    public static long whole(Object v) {
        return v instanceof Number ? ((Number) v).longValue() : 0L;
    }
}
