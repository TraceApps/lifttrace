package com.lifttrace.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.annotation.OptIn;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.session.MediaSession;
import androidx.media3.session.MediaSessionService;
import androidx.media3.session.MediaStyleNotificationHelper;

/**
 * Manual MediaSessionService — hosts a MediaSession around the ExoPlayer
 * instance owned by RadioPlayerPlugin and posts MediaStyle notifications
 * ourselves on every relevant player event.
 *
 * Why we don't use Media3's DefaultMediaNotificationProvider:
 *   Media3's MediaNotificationManager.updateNotification has an internal
 *   guard that calls maybeStopForegroundService(true) — which removes the
 *   notification — whenever the bound MediaController hasn't fully synced
 *   its view of the player. The controller binding is asynchronous, and
 *   during track transitions / state changes the controller's view of
 *   getCurrentTimeline / getPlaybackState can briefly look stale. Any
 *   call to onUpdateNotification in that window kills the notification,
 *   and on our flow (player already mid-playback when service starts)
 *   the timing was never reliable. Verified by decompiling Media3 1.4.1.
 *
 * What we do instead:
 *   - Override onUpdateNotification(session, boolean) and DON'T call super
 *     — bypasses MediaNotificationManager entirely.
 *   - Post a NotificationCompat MediaStyle notification ourselves on
 *     player events (track transition, isPlaying change, metadata change).
 *   - Async-load artwork from the current MediaItem's artworkUri and
 *     re-post the notification with the bitmap once it arrives.
 *   - Attach MediaStyleNotificationHelper.MediaStyle(_session) so the OS
 *     still recognizes this as a media notification linked to our session
 *     — that's what makes it eligible for the lockscreen media-player
 *     widget and for Bluetooth headphone control routing.
 */
@OptIn(markerClass = UnstableApi.class)
public class RadioPlaybackService extends MediaSessionService {
    private static final String TAG = "LtPlaybackSvc";
    static final int MEDIA_NOTIFICATION_ID = 1001;
    static final String CHANNEL_ID = "lifttrace_radio_session";

    private MediaSession _session;
    private final Handler _main = new Handler(Looper.getMainLooper());

    @Override
    public void onCreate() {
        super.onCreate();
        Log.i(TAG, "onCreate enter, sharedPlayer=" + (RadioPlayerPlugin.sharedPlayer != null ? "set" : "null"));
        ensureNotificationChannel();
        if (RadioPlayerPlugin.sharedPlayer == null) {
            Log.w(TAG, "onCreate early-return: no sharedPlayer");
            return;
        }

        // Tap on the notification → open the app.
        Intent launchIntent = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent sessionActivity = launchIntent != null
            ? PendingIntent.getActivity(this, 0, launchIntent,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT)
            : null;

        MediaSession.Builder builder =
            new MediaSession.Builder(this, RadioPlayerPlugin.sharedPlayer);
        if (sessionActivity != null) builder.setSessionActivity(sessionActivity);
        _session = builder.build();
        Log.i(TAG, "onCreate session built. player.playWhenReady="
            + RadioPlayerPlugin.sharedPlayer.getPlayWhenReady()
            + " state=" + RadioPlayerPlugin.sharedPlayer.getPlaybackState()
            + " mediaItemCount=" + RadioPlayerPlugin.sharedPlayer.getMediaItemCount());

        RadioPlayerPlugin.sharedPlayer.addListener(new Player.Listener() {
            @Override
            public void onMediaItemTransition(@Nullable MediaItem item, int reason) {
                String title = (item != null && item.mediaMetadata != null && item.mediaMetadata.title != null)
                    ? item.mediaMetadata.title.toString() : "(none)";
                Log.i(TAG, "Player.onMediaItemTransition: title=\"" + title + "\" reason=" + reason);
                postMediaNotification("itemTransition");
            }

            @Override
            public void onIsPlayingChanged(boolean isPlaying) {
                Log.i(TAG, "Player.onIsPlayingChanged: " + isPlaying);
                postMediaNotification("isPlayingChanged");
            }

            @Override
            public void onMediaMetadataChanged(@NonNull MediaMetadata metadata) {
                // Fires when applyMediaMetadata replaces the current MediaItem
                // for radio ICY/ID3 updates.
                Log.i(TAG, "Player.onMediaMetadataChanged");
                postMediaNotification("metadataChanged");
            }
        });

        // First post — covers the case where the player is already in
        // STATE_READY by the time the listener gets attached and no further
        // events fire to trigger a refresh.
        postMediaNotification("post-build");
    }

    /**
     * Hijack point — Media3 calls this on internal state changes. By NOT
     * calling super we bypass MediaNotificationManager entirely (which is
     * the path that kills the notification via maybeStopForegroundService).
     * Our manual postMediaNotification fires from our own Player.Listener
     * above; we just no-op here.
     */
    @Override
    public void onUpdateNotification(@NonNull MediaSession session, boolean startInForegroundRequired) {
        // Intentionally NOT calling super.onUpdateNotification — see class
        // javadoc for the reason. We do nothing here; the listener fires
        // postMediaNotification() on every relevant player event.
    }

    @Nullable
    @Override
    public MediaSession onGetSession(@NonNull MediaSession.ControllerInfo controllerInfo) {
        return _session;
    }

    @Override
    public int onStartCommand(@Nullable Intent intent, int flags, int startId) {
        Log.i(TAG, "onStartCommand startId=" + startId);
        // Beat the 5-second startForeground deadline with whatever we know
        // about the current track right now. If the player has already
        // loaded a MediaItem with metadata (the common case — plugin calls
        // play() before startForegroundService), we'll show that. Otherwise
        // a "Now playing" placeholder.
        try {
            Notification n = buildCurrentNotification();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(
                    MEDIA_NOTIFICATION_ID,
                    n,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
                );
            } else {
                startForeground(MEDIA_NOTIFICATION_ID, n);
            }
            Log.i(TAG, "startForeground posted");
            // Kick off async artwork load + re-post.
            postMediaNotification("onStartCommand");
        } catch (Throwable t) {
            Log.w(TAG, "startForeground threw: " + t.getMessage());
        }
        return super.onStartCommand(intent, flags, startId);
    }

    // ── Manual notification posting ────────────────────────────────────────

    /**
     * Build a notification synchronously from the current MediaItem's
     * MediaMetadata. Doesn't include artwork (loaded async in
     * postMediaNotification). Used for the synchronous startForeground call
     * inside onStartCommand.
     */
    private Notification buildCurrentNotification() {
        String title = "LiftTrace";
        String artist = "";
        String album = "";
        if (RadioPlayerPlugin.sharedPlayer != null) {
            MediaItem current = RadioPlayerPlugin.sharedPlayer.getCurrentMediaItem();
            if (current != null) {
                MediaMetadata md = current.mediaMetadata;
                if (md != null) {
                    if (md.title != null)      title  = md.title.toString();
                    if (md.artist != null)     artist = md.artist.toString();
                    if (md.albumTitle != null) album  = md.albumTitle.toString();
                }
            }
        }
        return buildBuilder(title, artist, album, null).build();
    }

    /**
     * Post a fresh media notification reflecting the current track. Loads
     * artwork asynchronously and re-posts when the bitmap is ready.
     */
    private void postMediaNotification(String origin) {
        if (_session == null) {
            Log.w(TAG, "postMediaNotification(" + origin + ") skip — no session");
            return;
        }
        if (RadioPlayerPlugin.sharedPlayer == null) {
            Log.w(TAG, "postMediaNotification(" + origin + ") skip — no player");
            return;
        }
        MediaItem current = RadioPlayerPlugin.sharedPlayer.getCurrentMediaItem();
        if (current == null) {
            Log.w(TAG, "postMediaNotification(" + origin + ") skip — no current item");
            return;
        }
        MediaMetadata md = current.mediaMetadata;

        final String title  = (md != null && md.title != null)      ? md.title.toString()      : "LiftTrace";
        final String artist = (md != null && md.artist != null)     ? md.artist.toString()     : "";
        final String album  = (md != null && md.albumTitle != null) ? md.albumTitle.toString() : "";
        final Uri    artUri = (md != null && md.artworkUri != null) ? md.artworkUri            : null;

        // Post immediately without artwork so metadata updates are instant.
        try {
            Notification n = buildBuilder(title, artist, album, null).build();
            NotificationManagerCompat.from(this).notify(MEDIA_NOTIFICATION_ID, n);
            Log.i(TAG, "postMediaNotification(" + origin + ") title=\"" + title + "\" art=" + (artUri != null));
        } catch (Throwable t) {
            Log.w(TAG, "postMediaNotification(" + origin + ") notify failed: " + t.getMessage());
        }

        // Async artwork load + re-post.
        if (artUri != null) {
            final Uri capturedUri = artUri;
            new Thread(() -> {
                Bitmap bmp = downloadBitmap(capturedUri);
                if (bmp == null) return;
                _main.post(() -> {
                    // Verify the current track is still the same one whose
                    // art we just downloaded — otherwise we'd post stale art
                    // for the track-after-this.
                    if (RadioPlayerPlugin.sharedPlayer == null) return;
                    MediaItem now = RadioPlayerPlugin.sharedPlayer.getCurrentMediaItem();
                    if (now == null) return;
                    Uri nowArt = (now.mediaMetadata != null) ? now.mediaMetadata.artworkUri : null;
                    if (nowArt == null || !capturedUri.equals(nowArt)) {
                        Log.i(TAG, "art download stale — current track changed; dropping bitmap");
                        return;
                    }
                    try {
                        Notification n = buildBuilder(title, artist, album, bmp).build();
                        NotificationManagerCompat.from(this).notify(MEDIA_NOTIFICATION_ID, n);
                        Log.i(TAG, "postMediaNotification(" + origin + ") re-posted with art");
                    } catch (Throwable t) {
                        Log.w(TAG, "art re-post failed: " + t.getMessage());
                    }
                });
            }, "LtArtLoader").start();
        }
    }

    private NotificationCompat.Builder buildBuilder(
            String title, String artist, String album, @Nullable Bitmap art) {
        Intent launchIntent = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent contentPI = launchIntent != null
            ? PendingIntent.getActivity(this, 0, launchIntent,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT)
            : null;
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_radio_notif)
            .setContentTitle(title)
            .setContentText(artist != null && !artist.isEmpty() ? artist : album)
            .setOngoing(true)
            .setSilent(true)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setPriority(NotificationCompat.PRIORITY_LOW);
        if (album != null && !album.isEmpty() && artist != null && !artist.isEmpty()) {
            b.setSubText(album);
        }
        if (art != null) b.setLargeIcon(art);
        if (contentPI != null) b.setContentIntent(contentPI);
        // The session reference is what makes this a "real" media notification
        // — the OS recognizes it for the lockscreen media-player widget +
        // Bluetooth-headphone control routing.
        if (_session != null) {
            b.setStyle(new MediaStyleNotificationHelper.MediaStyle(_session));
        }
        return b;
    }

    /** Synchronous bitmap download. Run on a background thread. */
    @Nullable
    private Bitmap downloadBitmap(Uri uri) {
        try {
            String s = uri.toString();
            // file:// or content:// — use ContentResolver
            if (s.startsWith("content://") || s.startsWith("file://")) {
                java.io.InputStream in = getContentResolver().openInputStream(uri);
                if (in == null) return null;
                try { return BitmapFactory.decodeStream(in); }
                finally { try { in.close(); } catch (Throwable ignored) {} }
            }
            // http(s):// — HttpURLConnection
            java.net.URL url = new java.net.URL(s);
            java.net.HttpURLConnection conn = (java.net.HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(8000);
            conn.setInstanceFollowRedirects(true);
            conn.setRequestProperty("User-Agent", "LiftTrace/1.0");
            int code = conn.getResponseCode();
            if (code < 200 || code >= 300) {
                Log.w(TAG, "downloadBitmap HTTP " + code + " for " + s);
                return null;
            }
            java.io.InputStream is = conn.getInputStream();
            try { return BitmapFactory.decodeStream(is); }
            finally { try { is.close(); } catch (Throwable ignored) {} }
        } catch (Throwable t) {
            Log.w(TAG, "downloadBitmap failed: " + t.getMessage());
            return null;
        }
    }

    @Override
    public void onDestroy() {
        if (_session != null) {
            try { _session.release(); }
            catch (Exception ignored) {}
            _session = null;
        }
        super.onDestroy();
    }

    private void ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm =
            (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel ch = new NotificationChannel(
            CHANNEL_ID, "Radio playback", NotificationManager.IMPORTANCE_LOW);
        ch.setDescription("Lockscreen + notification controls for LiftTrace radio playback.");
        ch.setShowBadge(false);
        nm.createNotificationChannel(ch);
    }
}
