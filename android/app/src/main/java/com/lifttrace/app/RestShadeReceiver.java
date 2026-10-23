package com.lifttrace.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * The rest notification's buttons, its alarm at zero, and its being swiped
 * away. Not exported: only this app's own PendingIntents reach it.
 */
public class RestShadeReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent == null ? null : intent.getAction();
        if (action == null) return;
        Context ctx = context.getApplicationContext();
        switch (action) {
            case RestShade.ACTION_END:
                RestShade.atZero(ctx);
                return;
            case RestShade.ACTION_DISMISSED:
                RestShade.dismissed(ctx);
                return;
            case RestShade.ACTION_SKIP:
            case RestShade.ACTION_ADD:
            case RestShade.ACTION_PAUSE:
            case RestShade.ACTION_RESUME:
                // Kept alive until a watch in use has been told too.
                PendingResult pending = goAsync();
                RestShade.act(ctx, action, () -> {
                    try { pending.finish(); } catch (Exception ignored) {}
                });
                return;
            default:
        }
    }
}
