package com.lifttrace.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import android.util.Log;

import com.google.android.gms.wearable.DataClient;
import com.google.android.gms.wearable.PutDataMapRequest;
import com.google.android.gms.wearable.PutDataRequest;
import com.google.android.gms.wearable.Wearable;

/**
 * Hands the watch what it needs to reach the server: the address and the
 * signed-in account's token, written once into the Wearable Data Layer. The
 * watch app (android/wear) picks it up and talks to the server itself, so it
 * logs sets in a gym with the phone in a locker.
 *
 * Nothing is typed on the watch, and signing out on the phone takes the
 * credentials away again.
 */
@CapacitorPlugin(name = "WearPairing")
public class WearPairingPlugin extends Plugin {

    private static final String PATH = "/lifttrace/pairing";
    private static final String TIMER_PATH = "/lifttrace/timer";
    private static final String TAG = "WearPairing";

    /** True when a watch is paired with this phone, so the UI can say so. */
    @PluginMethod
    public void hasWatch(PluginCall call) {
        Wearable.getNodeClient(getContext()).getConnectedNodes()
            .addOnSuccessListener(nodes -> {
                Log.i(TAG, "connected nodes: " + (nodes == null ? 0 : nodes.size()));
                JSObject ret = new JSObject();
                ret.put("paired", nodes != null && !nodes.isEmpty());
                ret.put("count", nodes == null ? 0 : nodes.size());
                call.resolve(ret);
            })
            .addOnFailureListener(e -> {
                Log.w(TAG, "couldn't list nodes: " + e.getMessage());
                JSObject ret = new JSObject();
                ret.put("paired", false);
                ret.put("count", 0);
                call.resolve(ret);
            });
    }

    /** Send the server address and token to the watch. */
    @PluginMethod
    public void pair(PluginCall call) {
        String serverUrl = call.getString("serverUrl", "");
        String token = call.getString("token", "");
        if (serverUrl == null || serverUrl.isEmpty() || token == null || token.isEmpty()) {
            call.reject("serverUrl and token are required");
            return;
        }
        PutDataMapRequest req = PutDataMapRequest.create(PATH);
        req.getDataMap().putString("serverUrl", serverUrl);
        req.getDataMap().putString("token", token);
        // The timestamp makes every write distinct, so re-pairing after a token
        // refresh still reaches the watch instead of being seen as unchanged.
        req.getDataMap().putLong("at", System.currentTimeMillis());
        PutDataRequest put = req.asPutDataRequest().setUrgent();

        DataClient client = Wearable.getDataClient(getContext());
        client.putDataItem(put)
            .addOnSuccessListener(item -> {
                Log.i(TAG, "sent the link to the watch");
                JSObject ret = new JSObject();
                ret.put("sent", true);
                call.resolve(ret);
            })
            .addOnFailureListener(e -> call.reject(e.getMessage() == null ? "Couldn't reach the watch" : e.getMessage()));
    }

    /**
     * How long this session has been running. Sent as a start time and a
     * running total rather than a count, so the watch keeps counting on its
     * own with the phone out of range.
     */
    @PluginMethod
    public void timer(PluginCall call) {
        PutDataMapRequest req = PutDataMapRequest.create(TIMER_PATH);
        req.getDataMap().putString("date", call.getString("date", ""));
        req.getDataMap().putLong("startTime", call.getDouble("startTime", 0d).longValue());
        req.getDataMap().putDouble("baseElapsed", call.getDouble("baseElapsed", 0d));
        req.getDataMap().putBoolean("paused", Boolean.TRUE.equals(call.getBoolean("paused", false)));
        req.getDataMap().putDouble("pausedElapsed", call.getDouble("pausedElapsed", 0d));
        req.getDataMap().putLong("at", System.currentTimeMillis());
        Wearable.getDataClient(getContext()).putDataItem(req.asPutDataRequest().setUrgent())
            .addOnSuccessListener(item -> call.resolve())
            .addOnFailureListener(e -> call.reject(e.getMessage() == null ? "Couldn't reach the watch" : e.getMessage()));
    }

    /** The session timer was cleared: the watch should stop showing one. */
    @PluginMethod
    public void clearTimer(PluginCall call) {
        Wearable.getDataClient(getContext())
            .deleteDataItems(new android.net.Uri.Builder().scheme("wear").path(TIMER_PATH).build())
            .addOnSuccessListener(count -> call.resolve())
            .addOnFailureListener(e -> call.reject(e.getMessage() == null ? "Couldn't reach the watch" : e.getMessage()));
    }

    /** Signed out on the phone: take the credentials off the watch. */
    @PluginMethod
    public void unpair(PluginCall call) {
        Wearable.getDataClient(getContext())
            .deleteDataItems(new android.net.Uri.Builder().scheme("wear").path(PATH).build())
            .addOnSuccessListener(count -> {
                JSObject ret = new JSObject();
                ret.put("cleared", true);
                call.resolve(ret);
            })
            .addOnFailureListener(e -> call.reject(e.getMessage() == null ? "Couldn't reach the watch" : e.getMessage()));
    }
}
