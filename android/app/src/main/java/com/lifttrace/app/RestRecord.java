package com.lifttrace.app;

/**
 * The rest between sets as this phone's native side holds it: what the rest
 * notification shows and acts on, with the app open, in the background or
 * long gone.
 *
 * Plain Java, no Android, so the arithmetic and the choice of what the
 * notification shows are tested on their own (RestRecordTest). RestShade does
 * the Android half: storing this, posting the notification, the alarms.
 *
 * A running rest is a deadline ({@link #endsAt}); a paused one is what was
 * left when it was paused ({@link #leftMs}), since a deadline keeps moving
 * closer while nobody is resting. {@link #at} stamps the last change, by
 * whoever made it, the same stamp the app and the watch go by: the later word
 * wins everywhere.
 */
public final class RestRecord {

    /** What the notification is showing. */
    public enum Kind { NONE, RUNNING, PAUSED }

    public boolean active;
    public boolean paused;
    public long endsAt;
    public long leftMs;
    /** Seconds the whole rest is, extensions included: what the bar fills toward. */
    public int total;
    /** When this rest started: which rest a dismissal was about. */
    public long startedAt;
    public long at;
    /** The diary day the rest belongs to, for "open the Diary on that workout". */
    public String date = "";
    /** The exercise name the watch shows. */
    public String label = "";

    // Words, all from the app's own translations: the receiver that acts on a
    // button has no web layer to ask.
    public String title = "";
    public String text = "";
    public String fallbackTitle = "";
    public String skip = "";
    public String add = "";
    public String pause = "";
    public String resume = "";
    /** "Rest paused, {time} left". */
    public String pausedText = "";
    /** The status bar chip while paused, where the countdown would be. */
    public String pausedChip = "";
    public int addSec = 30;
    /** "#RRGGBB", the app's accent. */
    public String accent = "#FF7433";
    /** The rest the person swiped away: it is not put back while it lasts. */
    public long dismissedFor;
    /**
     * The watch took the last word about this rest. A watch holding a pause
     * hears how it ends (Resume, Skip Rest) even after half an hour unopened,
     * or it would show "Paused" for good.
     */
    public boolean onWatch;

    public Kind kind(long now) {
        if (!active) return Kind.NONE;
        if (paused) return leftMs > 0 ? Kind.PAUSED : Kind.NONE;
        return endsAt > now ? Kind.RUNNING : Kind.NONE;
    }

    public long left(long now) {
        if (!active) return 0L;
        if (paused) return Math.max(0L, leftMs);
        return Math.max(0L, endsAt - now);
    }

    /** Through the rest, in thousandths, as the rest bar fills. */
    public int progress(long now) {
        if (total <= 0) return 0;
        double done = 1d - (left(now) / 1000d) / total;
        return (int) Math.round(Math.max(0d, Math.min(1d, done)) * 1000d);
    }

    public boolean dismissed() {
        return dismissedFor != 0L && dismissedFor == startedAt;
    }

    /** Held where it is. Returns false when there was nothing counting to pause. */
    public boolean pauseAt(long now) {
        if (kind(now) != Kind.RUNNING) return false;
        leftMs = endsAt - now;
        paused = true;
        at = now;
        return true;
    }

    /** Counting again from what was left. */
    public boolean resumeAt(long now) {
        if (kind(now) != Kind.PAUSED) return false;
        endsAt = now + leftMs;
        leftMs = 0L;
        paused = false;
        at = now;
        return true;
    }

    /** More rest, counting or paused. */
    public boolean extendAt(int seconds, long now) {
        Kind k = kind(now);
        if (k == Kind.NONE || seconds <= 0) return false;
        if (k == Kind.PAUSED) leftMs += seconds * 1000L;
        else endsAt += seconds * 1000L;
        total += seconds;
        at = now;
        return true;
    }

    /** Skipped, or over. */
    public void stopAt(long now) {
        active = false;
        paused = false;
        leftMs = 0L;
        at = now;
    }

    /**
     * The rest as the watch sent it (the /lifttrace/rest data item). Taken
     * only when it is the later word and this phone is holding a rest: a rest
     * started on the watch with none here is the app's to pick up when it is
     * next opened, as before.
     *
     * A paused rest arrives as cleared with paused beside it (see
     * src/lib/rest-state.js restToWire), so a watch from before pausing,
     * which sends no paused at all, still reads as stopped or running.
     *
     * Returns true when this record changed.
     */
    public boolean adoptWire(boolean cleared, boolean wirePaused, long wireLeftMs, long wireEndsAt,
                             int wireTotal, String wireLabel, long wireAt, long now) {
        if (!active) return false;
        if (wireAt <= at) return false;
        at = wireAt;
        // Said by the watch, so the watch has it.
        onWatch = true;
        if (wireLabel != null && !wireLabel.isEmpty() && !wireLabel.equals(label)) {
            // Another lift's rest: the next set this phone had lined up is
            // not this one, so the plain words go up instead.
            label = wireLabel;
            title = wireLabel;
            text = "";
        }
        if (wirePaused && wireLeftMs > 0) {
            paused = true;
            leftMs = wireLeftMs;
            if (wireTotal > 0) total = wireTotal;
            return true;
        }
        if (cleared || wireEndsAt <= now) {
            active = false;
            paused = false;
            leftMs = 0L;
            return true;
        }
        paused = false;
        leftMs = 0L;
        endsAt = wireEndsAt;
        if (wireTotal > 0) total = wireTotal;
        return true;
    }

    /** m:ss, whole seconds dropped, as the rest bar in the app writes it. */
    public static String clock(long ms) {
        long s = Math.max(0L, ms / 1000L);
        long m = s / 60L;
        long r = s % 60L;
        return m + ":" + (r < 10 ? "0" : "") + r;
    }

    /** "Rest paused, 1:12 left", from the translated template. */
    public String pausedLine(long now) {
        String clock = clock(left(now));
        if (pausedText == null || pausedText.isEmpty()) return clock;
        return pausedText.replace("{time}", clock);
    }

    public String titleOr() {
        if (title != null && !title.isEmpty()) return title;
        if (label != null && !label.isEmpty()) return label;
        return fallbackTitle == null ? "" : fallbackTitle;
    }

    /**
     * Redrawing once a second is for the bar only, so only while there is a
     * bar moving and somebody could be looking at it.
     */
    public boolean wantsTicks(boolean screenOn, long now) {
        return screenOn && !dismissed() && kind(now) == Kind.RUNNING;
    }
}
