package com.lifttrace.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import android.util.Log;

import com.google.android.gms.wearable.DataClient;
import com.google.android.gms.wearable.DataMapItem;
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
        req.getDataMap().putBoolean("cleared", false);
        // The stamp comes from whoever made the change, so both devices are
        // judging by the same reading rather than by when a write happened.
        req.getDataMap().putLong("at", stampOf(call));
        Wearable.getDataClient(getContext()).putDataItem(req.asPutDataRequest().setUrgent())
            .addOnSuccessListener(item -> call.resolve())
            .addOnFailureListener(e -> call.reject(e.getMessage() == null ? "Couldn't reach the watch" : e.getMessage()));
    }

    private long stampOf(PluginCall call) {
        Double at = call.getDouble("at", 0d);
        long stamp = at == null ? 0L : at.longValue();
        return stamp > 0 ? stamp : System.currentTimeMillis();
    }

    /**
     * What the watch says the session timer is doing. The phone reads this
     * when it comes back to the front and takes it if it is the later word,
     * so starting the timer on the wrist reaches the phone that writes the
     * session's length down.
     */
    @PluginMethod
    public void readTimer(PluginCall call) {
        Wearable.getDataClient(getContext()).getDataItems()
            .addOnSuccessListener(items -> {
                JSObject ret = new JSObject();
                ret.put("found", false);
                // Each device keeps its own record at this path, so this has
                // to be the NEWEST of them rather than whichever the loop
                // happens to reach last.
                long newest = 0L;
                for (com.google.android.gms.wearable.DataItem item : items) {
                    String path = item.getUri().getPath();
                    if (path == null || !path.startsWith(TIMER_PATH)) continue;
                    com.google.android.gms.wearable.DataMap map =
                        DataMapItem.fromDataItem(item).getDataMap();
                    long at = map.getLong("at", 0L);
                    if (at < newest) continue;
                    newest = at;
                    ret.put("found", true);
                    ret.put("date", map.getString("date", ""));
                    ret.put("startTime", map.getLong("startTime", 0L));
                    ret.put("baseElapsed", map.getDouble("baseElapsed", 0d));
                    ret.put("paused", map.getBoolean("paused", false));
                    ret.put("pausedElapsed", map.getDouble("pausedElapsed", 0d));
                    ret.put("at", at);
                    ret.put("cleared", map.getBoolean("cleared", false));
                }
                items.release();
                call.resolve(ret);
            })
            .addOnFailureListener(e -> {
                JSObject ret = new JSObject();
                ret.put("found", false);
                call.resolve(ret);
            });
    }

    /**
     * The session timer was stopped. Published as a stopped marker rather than
     * deleted, so both sides can tell "stopped a moment ago" from "nothing has
     * been said yet" and the later word still wins.
     */
    @PluginMethod
    public void clearTimer(PluginCall call) {
        PutDataMapRequest req = PutDataMapRequest.create(TIMER_PATH);
        req.getDataMap().putBoolean("cleared", true);
        req.getDataMap().putLong("at", stampOf(call));
        Wearable.getDataClient(getContext()).putDataItem(req.asPutDataRequest().setUrgent())
            .addOnSuccessListener(item -> call.resolve())
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
