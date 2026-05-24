package com.lifttrace.app;

import android.util.Log;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.InputStream;
import java.io.PipedInputStream;
import java.io.PipedOutputStream;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * StreamProxyPlugin — same-origin radio-stream proxy via WebView request
 * interception.
 *
 * Why this exists: Chromium's Web Audio API zeroes the output of
 * createMediaElementSource() when the audio source is cross-origin AND
 * the response doesn't carry CORS headers — a hard-coded silent-audio
 * security mitigation. A separate HTTP server on 127.0.0.1 doesn't work
 * either: the WebView's media loader blocks {@code <audio src=
 * "http://127.0.0.1:...">} on Private Network Access grounds even with
 * allowMixedContent enabled.
 *
 * Solution: don't proxy through a separate origin at all. Capacitor's
 * BridgeWebViewClient already serves {@code https://localhost/...} from
 * the bundled assets via shouldInterceptRequest(). We extend the SAME
 * mechanism so {@code https://localhost/_lt-proxy/<encoded-url>} returns
 * a streamed response from the upstream radio host, sourced via OkHttp
 * (HTTP/2-capable, redirect-aware) and fed through a PipedInputStream
 * for byte-streaming. The audio element sees a same-origin response →
 * no mixed-content gate, no PNA gate, no CORS zeroing, visualizer ring
 * works on every station.
 *
 * The plugin's JS API is unchanged — it just hands back a same-origin
 * URL the audio element can use.
 */
@CapacitorPlugin(name = "LtStreamProxy")
public class StreamProxyPlugin extends Plugin {
    private static final String TAG = "LtStreamProxy";
    public static final String INTERCEPT_PATH = "/_lt-proxy/";
    private static final int CONNECT_TIMEOUT_MS = 8000;
    private static final int PIPE_BUFFER = 64 * 1024;

    private static final OkHttpClient _http = new OkHttpClient.Builder()
        .connectTimeout(CONNECT_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        // No read timeout — these are infinite live streams
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .followRedirects(true)
        .followSslRedirects(true)
        .retryOnConnectionFailure(true)
        .build();

    // Tracks the current pump thread + response so a new station tap can
    // cleanly cancel the previous one. Without this the abandoned thread
    // keeps reading from upstream into a now-detached PipedInputStream
    // which blocks once the buffer fills, leaking the connection.
    private static final AtomicReference<PipeContext> _activePipe = new AtomicReference<>();

    private static class PipeContext {
        final Thread thread;
        final Response response;
        PipeContext(Thread t, Response r) { this.thread = t; this.response = r; }
    }

    @PluginMethod
    public void start(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("url required");
            return;
        }
        // Same-origin URL into the WebView's intercept path. The actual
        // upstream connection is opened LAZILY when the audio element loads
        // this path (see shouldInterceptProxyRequest below).
        String encoded = URLEncoder.encode(url, StandardCharsets.UTF_8);
        JSObject ret = new JSObject();
        ret.put("localUrl", "https://localhost" + INTERCEPT_PATH + encoded);
        call.resolve(ret);
    }

    /** Cancel any currently-running pump (called from JS when the user
     *  stops playback or switches station). Idempotent. */
    @PluginMethod
    public void stop(PluginCall call) {
        cancelActivePipe("stop()");
        call.resolve();
    }

    private static synchronized void cancelActivePipe(String reason) {
        PipeContext prev = _activePipe.getAndSet(null);
        if (prev == null) return;
        Log.i(TAG, "cancelling active pipe (" + reason + ")");
        try { prev.response.close(); } catch (Exception ignored) {}
        if (prev.thread != null) prev.thread.interrupt();
    }

    /**
     * Called from {@link MainActivity}'s WebViewClient subclass when a request
     * starts with {@link #INTERCEPT_PATH}. Returns a streaming
     * WebResourceResponse, or null if the request isn't a proxy path.
     */
    public static WebResourceResponse shouldInterceptProxyRequest(WebResourceRequest request) {
        String path = request.getUrl().getPath();
        if (path == null || !path.startsWith(INTERCEPT_PATH)) return null;

        // Drop any prior pipe before opening a new one. Otherwise the old
        // pump thread keeps reading bytes that nobody consumes, eventually
        // blocks on the full pipe, and leaks the upstream connection.
        cancelActivePipe("new request");

        String encodedUrl = path.substring(INTERCEPT_PATH.length());
        String upstreamUrl;
        try { upstreamUrl = URLDecoder.decode(encodedUrl, StandardCharsets.UTF_8); }
        catch (Exception e) { return errorResponse(400, "bad url"); }

        Log.i(TAG, "intercept: piping " + upstreamUrl);

        Request req = new Request.Builder()
            .url(upstreamUrl)
            .header("User-Agent", "LiftTrace/1.0")
            .header("Icy-MetaData", "0")
            .build();

        Response upstream;
        try { upstream = _http.newCall(req).execute(); }
        catch (Exception e) {
            Log.w(TAG, "upstream connect failed: " + e.getMessage());
            return errorResponse(502, "upstream connect failed");
        }
        if (!upstream.isSuccessful()) {
            int code = upstream.code();
            try { upstream.close(); } catch (Exception ignored) {}
            return errorResponse(code, "upstream " + code);
        }

        String contentType = upstream.header("Content-Type");
        if (contentType == null || contentType.isEmpty()) contentType = "audio/mpeg";

        // 64KB pipe buffer — empirically the value that lets the demuxer
        // identify the format quickly. Larger buffers (256KB) caused
        // FFmpegDemuxer to give up before enough sync data arrived; smaller
        // buffers (8KB default) blocked the pump too aggressively.
        PipedInputStream sink = new PipedInputStream(64 * 1024);
        PipedOutputStream source;
        try {
            source = new PipedOutputStream(sink);
        } catch (Exception e) {
            try { upstream.close(); } catch (Exception ignored) {}
            return errorResponse(500, "pipe init failed");
        }

        Thread pipeThread = new Thread(() -> pumpResponse(upstream, source), "LtStreamProxyPipe");
        pipeThread.setDaemon(true);
        _activePipe.set(new PipeContext(pipeThread, upstream));
        pipeThread.start();

        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-cache, no-store");
        // Same-origin response — no need for Access-Control-Allow-Origin in
        // theory, but include it anyway since some Chromium media paths
        // double-check CORS for AudioContext use.
        headers.put("Access-Control-Allow-Origin", "*");

        // Strip "; charset=..." — WebResourceResponse's mimeType arg is just
        // the bare type. Many radio servers emit "audio/mpeg; charset=UTF-8".
        String bareMime = contentType.split(";")[0].trim();
        String charset = null;
        for (String part : contentType.split(";")) {
            String t = part.trim();
            if (t.toLowerCase().startsWith("charset=")) { charset = t.substring(8); break; }
        }

        WebResourceResponse resp = new WebResourceResponse(bareMime, charset, sink);
        resp.setStatusCodeAndReasonPhrase(200, "OK");
        resp.setResponseHeaders(headers);
        return resp;
    }

    private static void pumpResponse(Response upstream, PipedOutputStream out) {
        try (Response u = upstream;
             ResponseBody body = u.body();
             InputStream in = body != null ? body.byteStream() : null;
             PipedOutputStream o = out) {
            if (in == null) return;
            byte[] buf = new byte[8192];
            int n;
            while (!Thread.currentThread().isInterrupted() && (n = in.read(buf)) > 0) {
                o.write(buf, 0, n);
                o.flush();
            }
        } catch (Exception e) {
            // Either upstream broke or the WebView closed the pipe (user
            // paused / switched station). Both are normal.
        } finally {
            // Clear the active reference if we're still it. cancelActivePipe()
            // may have already cleared it, in which case a new request is
            // running and we shouldn't touch the new context.
            PipeContext cur = _activePipe.get();
            if (cur != null && cur.response == upstream) {
                _activePipe.compareAndSet(cur, null);
            }
        }
    }

    private static WebResourceResponse errorResponse(int code, String msg) {
        Map<String, String> headers = new HashMap<>();
        headers.put("Access-Control-Allow-Origin", "*");
        WebResourceResponse r = new WebResourceResponse(
            "text/plain", "utf-8",
            new java.io.ByteArrayInputStream(msg.getBytes(StandardCharsets.UTF_8))
        );
        r.setStatusCodeAndReasonPhrase(code, msg);
        r.setResponseHeaders(headers);
        return r;
    }
}
