package com.lifttrace.app;

import android.net.Uri;

import androidx.annotation.Nullable;

import java.io.IOException;
import java.util.Collections;

import okhttp3.Call;
import okhttp3.ConnectionSpec;
import okhttp3.HttpUrl;
import okhttp3.Interceptor;
import okhttp3.OkHttpClient;

/**
 * Plain http:// from the app's own native code: the radio and music player,
 * the stream proxy and the lockscreen artwork (from TraceApps/nutritrace#194).
 *
 * The app allows cleartext app-wide now, because Android can't scope it by
 * address, and enforces the rule itself. Here that means: https:// as
 * before, and plain http:// only to the one origin the app passes in, the
 * person's own LiftTrace server once they said Connect Anyway to it
 * (src/lib/plain-http.js, confirmedServerOrigin). Internet radio stations and
 * anything else on http:// stay refused, exactly as they were.
 */
final class PlainHttpGate {
    private PlainHttpGate() {}

    // "http://host:port" as OkHttp reads it, or null: no plain HTTP at all.
    private static volatile String sOrigin = null;

    /** The confirmed server's origin from the app, or null/empty for none. */
    static void setConfirmedOrigin(@Nullable String origin) {
        HttpUrl u = origin == null || origin.isEmpty() ? null : HttpUrl.parse(origin);
        sOrigin = u != null && "http".equals(u.scheme()) ? key(u) : null;
    }

    private static String key(HttpUrl u) {
        return u.scheme() + "://" + u.host() + ":" + u.port();
    }

    static boolean allowed(HttpUrl u) {
        if (u.isHttps()) return true;
        String o = sOrigin;
        return o != null && o.equals(key(u));
    }

    /** Whether the app's native code may fetch this http(s) URL. Anything else is not a network fetch. */
    static boolean allowed(@Nullable String url) {
        if (url == null) return false;
        String lower = url.trim().toLowerCase(java.util.Locale.ROOT);
        if (!lower.startsWith("http:") && !lower.startsWith("https:")) return true;
        HttpUrl u = HttpUrl.parse(url.trim());
        return u != null && allowed(u);
    }

    /** An artwork URI the player may load, or null when it would be refused plain HTTP. */
    @Nullable
    static Uri artworkUri(@Nullable String url) {
        if (url == null || url.isEmpty() || !allowed(url)) return null;
        try { return Uri.parse(url); } catch (Throwable t) { return null; }
    }

    // Plain HTTP only to the confirmed origin, checked before anything is sent.
    private static final Interceptor GUARD = chain -> {
        HttpUrl u = chain.request().url();
        if (!allowed(u)) throw new IOException("plain HTTP to " + u.host() + " refused (not your confirmed server)");
        return chain.proceed(chain.request());
    };

    /**
     * Calls through `base`, split by scheme: https:// with no cleartext at all
     * (a redirect to http:// fails, as it did when the app refused cleartext),
     * and http:// only to the confirmed origin, never following a redirect.
     */
    static Call.Factory callFactory(OkHttpClient base) {
        OkHttpClient https = base.newBuilder()
            .connectionSpecs(Collections.singletonList(ConnectionSpec.MODERN_TLS))
            .build();
        OkHttpClient plain = base.newBuilder()
            .followRedirects(false)
            .followSslRedirects(false)
            .addInterceptor(GUARD)
            .build();
        return request -> request.url().isHttps() ? https.newCall(request) : plain.newCall(request);
    }
}
