package com.lifttrace.app;

import android.os.Bundle;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Custom plugins must be registered BEFORE super.onCreate so the
        // bridge picks them up when it builds its plugin handle map.
        registerPlugin(StreamProxyPlugin.class);
        registerPlugin(RadioPlayerPlugin.class);
        registerPlugin(RestTimerCuePlugin.class);

        super.onCreate(savedInstanceState);

        // Replace the bridge's WebViewClient with one that intercepts
        // requests to /_lt-proxy/<encoded-url> and serves them as
        // same-origin streamed audio. See StreamProxyPlugin for why this
        // matters — short version: cross-origin <audio> + Web Audio API
        // would zero the output, and a separate-port loopback server
        // gets blocked by Chromium's Private Network Access policy.
        // Same-origin interception sidesteps both.
        WebView wv = bridge.getWebView();
        wv.setWebViewClient(new BridgeWebViewClient(bridge) {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                WebResourceResponse proxied = StreamProxyPlugin.shouldInterceptProxyRequest(request);
                if (proxied != null) return proxied;
                return super.shouldInterceptRequest(view, request);
            }
        });

        // Kick off (or KEEP an existing instance of) the periodic reminder worker.
        // Idempotent — WorkerScheduler uses ExistingPeriodicWorkPolicy.KEEP.
        try { WorkerScheduler.reschedule(getApplicationContext()); } catch (Throwable ignored) {}
    }
}
