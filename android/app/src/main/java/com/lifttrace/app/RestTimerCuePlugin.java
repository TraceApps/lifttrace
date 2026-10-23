package com.lifttrace.app;

import android.app.Activity;
import android.content.Intent;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * RestTimerCue: the rest timer's native half.
 *
 * Cues: AlarmManager broadcasts that fire SHORT audio + vibration cues
 * without posting any notification (RestCues, RestTimerCueReceiver). Why
 * this exists: Capacitor's LocalNotifications is the only stock way to fire
 * sound/vibration while the WebView is suspended, but every notification it
 * posts is visible in the shade. Users were getting 4-5 stacked rest-timer
 * rows per countdown.
 *
 * The rest itself: the ongoing notification in the shade and on the lock
 * screen while a rest runs or is paused (RestShade), whose buttons work with
 * the app closed. The app tells it what the rest is; it tells the app what
 * its buttons, or the watch, changed.
 *
 * JS contract (src/lib/rest-cue.js):
 *   schedule({ cues: [{ at, sound, vibrate, finale, title, body, localOnly, alarm }], endsAt })
 *   cancel()
 *   show({ ...the rest and its words })   hide({ at })   state()
 *   events: "restChanged" (the record), "openRest" ({ date }, kept until heard)
 */
@CapacitorPlugin(name = "RestTimerCue")
public class RestTimerCuePlugin extends Plugin {

    /** A number from the call, whatever size it arrived as (see JsNumber). */
    private long whole(PluginCall call, String name) {
        return JsNumber.whole(call.getData().opt(name));
    }

    @Override
    public void load() {
        RestShade.listener = r -> notifyListeners("restChanged", toJs(r));
        // Opened from the notification with the app not running.
        Activity activity = getActivity();
        if (activity != null) opened(activity.getIntent());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        opened(intent);
    }

    @Override
    protected void handleOnResume() {
        RestShade.appInFront = true;
        // In front, the app plays the countdown itself: cues armed while it
        // was away (by the notification's buttons or the watch) come down, or
        // a cold start from the notification would hear both.
        RestShade.onMain(() -> RestCues.hold(getContext()));
    }

    @Override
    protected void handleOnPause() {
        RestShade.appInFront = false;
    }

    @Override
    protected void handleOnDestroy() {
        RestShade.listener = null;
        RestShade.appInFront = false;
    }

    /** Tapped: the app goes to the Diary on that workout, now or once it is listening. */
    private void opened(Intent intent) {
        if (intent == null || !RestShade.ACTION_OPEN.equals(intent.getAction())) return;
        JSObject data = new JSObject();
        data.put("date", intent.getStringExtra("date") == null ? "" : intent.getStringExtra("date"));
        // Heard once: a recreated activity keeps its intent and would say it again.
        intent.setAction(Intent.ACTION_MAIN);
        notifyListeners("openRest", data, true);
    }

    @PluginMethod
    public void schedule(PluginCall call) {
        JSArray cues = call.getArray("cues");
        if (cues == null) { call.reject("cues array is required"); return; }
        long endsAt = whole(call, "endsAt");
        RestShade.onMain(() -> {
            int scheduled = RestCues.schedule(getContext(), cues, endsAt);
            JSObject ret = new JSObject();
            ret.put("scheduled", scheduled);
            call.resolve(ret);
        });
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        RestShade.onMain(() -> {
            RestCues.cancel(getContext());
            call.resolve();
        });
    }

    /** The rest as the app has it now: started, extended, paused or resumed. */
    @PluginMethod
    public void show(PluginCall call) {
        RestRecord r = new RestRecord();
        r.active = true;
        r.paused = Boolean.TRUE.equals(call.getBoolean("paused", false));
        r.endsAt = whole(call, "endsAt");
        r.leftMs = whole(call, "leftMs");
        r.total = (int) whole(call, "total");
        r.startedAt = whole(call, "startedAt");
        r.at = whole(call, "at");
        if (r.at <= 0) r.at = System.currentTimeMillis();
        r.date = call.getString("date", "");
        r.label = call.getString("label", "");
        r.title = call.getString("title", "");
        r.text = call.getString("text", "");
        r.fallbackTitle = call.getString("fallbackTitle", "");
        r.skip = call.getString("skip", "");
        r.add = call.getString("add", "");
        r.pause = call.getString("pause", "");
        r.resume = call.getString("resume", "");
        r.pausedText = call.getString("pausedText", "");
        r.pausedChip = call.getString("pausedChip", "");
        int addSec = (int) whole(call, "addSec");
        r.addSec = addSec > 0 ? addSec : 30;
        r.accent = call.getString("accent", "#FF7433");
        boolean keepWords = Boolean.TRUE.equals(call.getBoolean("keepWords", false));
        boolean wordsOnly = Boolean.TRUE.equals(call.getBoolean("wordsOnly", false));
        JSArray cues = call.getArray("cues");
        long cuesEnd = whole(call, "cuesEnd");
        RestShade.onMain(() -> {
            if (wordsOnly) {
                RestShade.words(getContext(), r.startedAt, r.title, r.text);
            } else {
                // This rest's sound and buzz, for the notification's Resume and +30s.
                if (cues != null && r.at >= RestShade.load(getContext()).at) RestCues.keep(getContext(), cues, cuesEnd);
                RestShade.fromApp(getContext(), r, keepWords);
            }
            call.resolve();
        });
    }

    /** Put the notification back from its own record (a force-stop takes it). */
    @PluginMethod
    public void repost(PluginCall call) {
        RestShade.onMain(() -> {
            RestShade.refresh(getContext());
            call.resolve();
        });
    }

    /** Whether the watch took the app's word stamped `at`. */
    @PluginMethod
    public void onWatch(PluginCall call) {
        long at = whole(call, "at");
        boolean took = Boolean.TRUE.equals(call.getBoolean("took", false));
        RestShade.onMain(() -> {
            RestShade.watchTook(getContext(), at, took);
            call.resolve();
        });
    }

    /** The rest is over, skipped or stopped in the app. */
    @PluginMethod
    public void hide(PluginCall call) {
        long at = whole(call, "at");
        RestShade.onMain(() -> {
            RestRecord r = RestShade.load(getContext());
            RestRecord next = new RestRecord();
            next.active = false;
            next.at = at > 0 ? at : System.currentTimeMillis();
            next.dismissedFor = r.dismissedFor;
            RestShade.fromApp(getContext(), next, false);
            call.resolve();
        });
    }

    /** What the notification last had, so the app can catch up with its buttons. */
    @PluginMethod
    public void state(PluginCall call) {
        RestShade.onMain(() -> call.resolve(toJs(RestShade.load(getContext()))));
    }

    private static JSObject toJs(RestRecord r) {
        JSObject o = new JSObject();
        o.put("found", r.at > 0);
        o.put("active", r.active);
        o.put("paused", r.paused);
        o.put("endsAt", r.endsAt);
        o.put("leftMs", r.leftMs);
        o.put("total", r.total);
        o.put("startedAt", r.startedAt);
        o.put("at", r.at);
        o.put("label", r.label);
        o.put("date", r.date);
        return o;
    }
}
