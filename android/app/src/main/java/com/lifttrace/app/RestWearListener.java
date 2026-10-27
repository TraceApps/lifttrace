package com.lifttrace.app;

import com.google.android.gms.wearable.DataEvent;
import com.google.android.gms.wearable.DataEventBuffer;
import com.google.android.gms.wearable.DataMap;
import com.google.android.gms.wearable.DataMapItem;
import com.google.android.gms.wearable.WearableListenerService;

/**
 * The watch paused, resumed, extended or skipped the rest, heard with this
 * app in the background or not running at all.
 *
 * Before pausing existed the phone only caught up when the app was next
 * opened, which was harmless while a rest could only end early. A paused
 * rest is different: left alone, this phone's alarms would ring at the old
 * deadline in the middle of the pause, and its notification would count down
 * a rest that is not counting. So the change is applied here, to a rest this
 * phone is holding; a rest started on the watch with none here is still the
 * app's to take up when it is opened (App.svelte syncRest).
 */
public class RestWearListener extends WearableListenerService {
    private static final String REST_PATH = "/lifttrace/rest";

    @Override
    public void onDataChanged(DataEventBuffer events) {
        for (DataEvent event : events) {
            if (event.getType() == DataEvent.TYPE_DELETED) continue;
            String path = event.getDataItem().getUri().getPath();
            if (path == null || !path.startsWith(REST_PATH)) continue;
            DataMap map = DataMapItem.fromDataItem(event.getDataItem()).getDataMap();
            boolean cleared = map.getBoolean("cleared", false);
            boolean paused = map.getBoolean("paused", false);
            long leftMs = map.getLong("leftMs", 0L);
            long endsAt = map.getLong("endsAt", 0L);
            int total = map.getInt("total", 0);
            String label = map.getString("label", "");
            long at = map.getLong("at", 0L);
            // This phone's own writes come back here too; their stamp is the
            // one already held, so they change nothing. On the main thread,
            // with every other change to the rest.
            // Waited for, so the process isn't let go before it is done.
            java.util.concurrent.CountDownLatch done = new java.util.concurrent.CountDownLatch(1);
            RestShade.onMain(() -> {
                try {
                    RestShade.fromWatch(getApplicationContext(), cleared, paused, leftMs, endsAt, total, label, at);
                } finally {
                    done.countDown();
                }
            });
            try { done.await(3, java.util.concurrent.TimeUnit.SECONDS); } catch (InterruptedException ignored) {}
        }
    }
}
