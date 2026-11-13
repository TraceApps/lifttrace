package com.lifttrace.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

import java.nio.charset.StandardCharsets;

/**
 * Debug builds only: stands in for the watch in Local mode (#156), so the
 * phone's answer can be checked on an emulator with no watch paired.
 *
 *   adb shell am broadcast -n com.lifttrace.app/.WatchRequestProbe \
 *     --es request '{"method":"GET","path":"/api/settings","body":null}'
 *
 * The answer is logged under the tag WatchRequestProbe.
 */
public class WatchRequestProbe extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String request = intent.getStringExtra("request");
        WearPairingPlugin plugin = WearPairingPlugin.current;
        if (plugin == null || request == null) {
            Log.i("WatchRequestProbe", "no app running or no request");
            return;
        }
        PendingResult pending = goAsync();
        plugin.askLikeTheWatch(request.getBytes(StandardCharsets.UTF_8))
            .addOnSuccessListener(bytes -> { Log.i("WatchRequestProbe", "answer " + new String(bytes, StandardCharsets.UTF_8)); pending.finish(); })
            .addOnFailureListener(e -> { Log.i("WatchRequestProbe", "failed " + e.getMessage()); pending.finish(); });
    }
}
