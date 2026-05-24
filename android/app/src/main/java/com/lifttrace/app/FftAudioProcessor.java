package com.lifttrace.app;

import androidx.annotation.OptIn;
import androidx.media3.common.C;
import androidx.media3.common.audio.AudioProcessor;
import androidx.media3.common.audio.BaseAudioProcessor;
import androidx.media3.common.util.UnstableApi;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.ShortBuffer;

/**
 * AudioProcessor that taps the PCM stream flowing through ExoPlayer's audio
 * pipeline, computes a 256-point FFT on it, and emits magnitude bins to a
 * listener. The audio passes through unmodified — we just sample it on the
 * way to the speaker.
 *
 * Why not android.media.audiofx.Visualizer? On many recent OEM Android builds
 * (Pixel 7+ on Android 13+ in particular) the system Visualizer service
 * returns INIT_CHECK_FAILED (-3) for media-output sessions, regardless of
 * whether the app explicitly allocates the session ID via AudioManager. The
 * audio policy refuses to expose the output to a Visualizer instance even for
 * the app's own session. We can't change that from app code.
 *
 * AudioProcessor avoids the problem entirely: we're inside our own decoder
 * pipeline, before the audio reaches AudioTrack, so no system permission or
 * policy applies. Works on every device where ExoPlayer plays sound.
 *
 * Output format: 128 bytes, one per FFT bin, dB-compressed in [0, 255] —
 * matches what Web Audio's `AnalyserNode.getByteFrequencyData()` emits on
 * the PWA. Same scaling on both platforms means the FAB visualizer ring
 * behaves 1:1 between PWA and Android: bass bin clipping looks the same,
 * mid/high bin response curves look the same.
 *
 * The legacy raw (real, imaginary) layout that Android's `Visualizer` uses
 * is NOT compatible with this — the linear magnitudes that produces have
 * such a wide dynamic range that one strong bin saturates while every
 * other bin reads as near-zero, leaving only one bar of the FAB ring
 * actually reacting to the music.
 *
 * Throttled to ~30Hz so we don't flood the Capacitor bridge — matches the
 * old Visualizer's effective output rate.
 */
@OptIn(markerClass = UnstableApi.class)
public class FftAudioProcessor extends BaseAudioProcessor {
    // fftSize = 64 mirrors what the PWA's Trace.svelte constructs on
    // AnalyserNode. Chromium uses exactly this size for the 32-bar ring
    // (fftSize/2 = 32 frequency bins). Using a larger FFT here and
    // averaging back down to 32 bars introduced a different frequency
    // response per bar — short windows have wider per-bin bandwidth, so
    // matching fftSize is the only way to match the per-bar response.
    private static final int FFT_SIZE = 64;
    private static final int OUT_SIZE = FFT_SIZE / 2;   // 32 bins, one byte each
    // ~60Hz emit rate — matches the PWA path which reads AnalyserNode
    // on every requestAnimationFrame (~60 fps on a typical display).
    // Anything slower visibly stutters next to the web reference.
    private static final long EMIT_INTERVAL_NS = 16_000_000L;

    // Web Audio AnalyserNode default thresholds — mirroring these means every
    // bar that would respond on the PWA also responds at the same pixel
    // height on native.
    private static final float MIN_DB = -100f;
    private static final float MAX_DB = -30f;
    private static final float DB_RANGE = MAX_DB - MIN_DB;
    // Per-bin magnitude normalization. Chromium's RealtimeAnalyser
    // (third_party/blink/renderer/modules/webaudio/realtime_analyser.cc,
    // DoFFTAnalysis) computes magnitude as (1/N) * sqrt(re² + im²) on
    // its Blackman-windowed data. Empirically this lands close to the
    // PWA reading without explicit window-gain compensation — Chromium
    // either doesn't compensate or does so implicitly through a different
    // path. A previous attempt to divide by Blackman's full coherent
    // gain (0.42) over-boosted bars by ~7.5 dB so almost every bin hit
    // max. Sticking with the plain 1/N from the spec text reads closer.
    private static final float MAG_NORM = 1f / FFT_SIZE;

    // Mirrors AnalyserNode's smoothingTimeConstant default. Smoothing
    // happens on LINEAR magnitudes BEFORE the dB conversion — per the W3C
    // spec — not on the post-dB byte values. Applying it post-dB (as the
    // JS side used to) produced a perceptibly different curve because
    // log-scale smoothing != linear-scale smoothing.
    private static final float SMOOTHING = 0.75f;

    public interface FftListener {
        void onFftBins(byte[] bins);
    }

    private FftListener _listener;

    private final short[] _window = new short[FFT_SIZE];
    private final float[] _re = new float[FFT_SIZE];
    private final float[] _im = new float[FFT_SIZE];
    private final byte[] _outBins = new byte[OUT_SIZE];
    // Per-bin smoothed magnitude state — persisted across emits so each
    // new frame blends with the previous (see SMOOTHING comment above).
    private final float[] _smoothedMag = new float[OUT_SIZE];

    // Blackman window precomputed once. Chromium's RealtimeAnalyser uses
    // Blackman with these exact coefficients (a0=0.42, a1=0.5, a2=0.08).
    // Using Hann here produced a perceptibly different per-bar response
    // because the windows have different main-lobe width + side-lobe levels.
    private final float[] _blackman = new float[FFT_SIZE];
    {
        final double a0 = 0.42;
        final double a1 = 0.5;
        final double a2 = 0.08;
        for (int i = 0; i < FFT_SIZE; i++) {
            double x = (2.0 * Math.PI * i) / FFT_SIZE;
            _blackman[i] = (float) (a0 - a1 * Math.cos(x) + a2 * Math.cos(2.0 * x));
        }
    }

    private int _writeIdx = 0;
    private int _channelCount = 1;
    private long _lastEmitNs = 0;

    public void setListener(FftListener l) { _listener = l; }

    @Override
    public AudioFormat onConfigure(AudioFormat in) throws UnhandledAudioFormatException {
        // We only handle 16-bit PCM. ExoPlayer outputs this for all the audio
        // codecs the radio + library actually use (MP3 / AAC / FLAC / Opus
        // all decode to PCM_16BIT by default on Android).
        if (in.encoding != C.ENCODING_PCM_16BIT) throw new UnhandledAudioFormatException(in);
        _channelCount = in.channelCount;
        return in; // pass-through, same format on the output side
    }

    @Override
    public void queueInput(ByteBuffer in) {
        int remaining = in.remaining();
        if (remaining == 0) return;

        // Tap the buffer for FFT BEFORE the pass-through write consumes it.
        // duplicate() shares the bytes but has its own position cursor.
        ByteBuffer fftView = in.duplicate();
        fftView.order(ByteOrder.nativeOrder());
        accumulate(fftView.asShortBuffer());

        // Pass-through to output: copy input bytes verbatim. out.put(in)
        // advances both cursors; after this, in.remaining() == 0.
        ByteBuffer out = replaceOutputBuffer(remaining);
        out.put(in);
        out.flip();
    }

    /** Read shorts off the buffer, mix to mono, accumulate into the FFT window. */
    private void accumulate(ShortBuffer sb) {
        if (_channelCount >= 2) {
            // Stereo (or more) — average the first two channels into mono. Most
            // music has stereo channels with similar spectral content; mixing
            // them produces a representative magnitude curve.
            while (sb.remaining() >= _channelCount) {
                int sum = sb.get() + sb.get();
                for (int c = 2; c < _channelCount; c++) sb.get();   // discard extras
                _window[_writeIdx++] = (short) (sum / 2);
                if (_writeIdx >= FFT_SIZE) {
                    _writeIdx = 0;
                    maybeEmit();
                }
            }
        } else {
            while (sb.hasRemaining()) {
                _window[_writeIdx++] = sb.get();
                if (_writeIdx >= FFT_SIZE) {
                    _writeIdx = 0;
                    maybeEmit();
                }
            }
        }
    }

    private void maybeEmit() {
        long now = System.nanoTime();
        if (now - _lastEmitNs < EMIT_INTERVAL_NS) return;   // throttle to ~30Hz
        _lastEmitNs = now;

        // Window + load real-valued PCM into complex arrays
        for (int i = 0; i < FFT_SIZE; i++) {
            _re[i] = (_window[i] / 32768f) * _blackman[i];
            _im[i] = 0f;
        }
        fftInPlace(_re, _im);
        packBins();
        if (_listener != null) _listener.onFftBins(_outBins);
    }

    /**
     * Iterative Cooley-Tukey radix-2 FFT, in place. Operates on the supplied
     * real and imaginary arrays of equal power-of-two length.
     */
    private static void fftInPlace(float[] re, float[] im) {
        int n = re.length;
        // Bit-reverse permutation
        for (int i = 1, j = 0; i < n; i++) {
            int bit = n >> 1;
            for (; (j & bit) != 0; bit >>= 1) j ^= bit;
            j ^= bit;
            if (i < j) {
                float t = re[i]; re[i] = re[j]; re[j] = t;
                t = im[i]; im[i] = im[j]; im[j] = t;
            }
        }
        // Butterflies
        for (int size = 2; size <= n; size <<= 1) {
            int half = size >> 1;
            double angle = -2.0 * Math.PI / size;
            float wReBase = (float) Math.cos(angle);
            float wImBase = (float) Math.sin(angle);
            for (int start = 0; start < n; start += size) {
                float wRe = 1f, wIm = 0f;
                for (int k = 0; k < half; k++) {
                    int p = start + k;
                    int q = p + half;
                    float tRe = wRe * re[q] - wIm * im[q];
                    float tIm = wRe * im[q] + wIm * re[q];
                    re[q] = re[p] - tRe;
                    im[q] = im[p] - tIm;
                    re[p] += tRe;
                    im[p] += tIm;
                    float nRe = wRe * wReBase - wIm * wImBase;
                    float nIm = wRe * wImBase + wIm * wReBase;
                    wRe = nRe;
                    wIm = nIm;
                }
            }
        }
    }

    /**
     * Mirrors AnalyserNode.getByteFrequencyData() per the W3C Web Audio
     * spec (§1.5.2.5). Three steps:
     *
     *   1. magnitude:  sqrt(re² + im²) * 2/N        (linear-scale, normalized)
     *   2. smoothing:  s * prev + (1 - s) * mag     (on LINEAR mag, in place)
     *   3. dB + map:   byte = round((clamp(dB) - minDB) * 255 / dbRange)
     *
     * Smoothing on linear magnitudes BEFORE dB conversion is critical;
     * the prior implementation smoothed bar heights AFTER dB conversion
     * which produced a perceptibly different curve from the PWA.
     *
     * Bin 0 (DC) uses |real| only since imag is implicitly 0. The Nyquist
     * bin is dropped — Web Audio omits it too.
     */
    private void packBins() {
        for (int i = 0; i < OUT_SIZE; i++) {
            float mag = (i == 0)
                ? Math.abs(_re[0]) * MAG_NORM
                : (float) Math.hypot(_re[i], _im[i]) * MAG_NORM;
            _smoothedMag[i] = SMOOTHING * _smoothedMag[i] + (1f - SMOOTHING) * mag;
            _outBins[i] = magToByte(_smoothedMag[i]);
        }
    }

    private static byte magToByte(float mag) {
        if (mag <= 0f) return 0;
        float db = 20f * (float) Math.log10(mag);
        if (db < MIN_DB) db = MIN_DB;
        if (db > MAX_DB) db = MAX_DB;
        int v = Math.round((db - MIN_DB) * 255f / DB_RANGE);
        if (v < 0) v = 0;
        if (v > 255) v = 255;
        // Java byte is signed [-128, 127]; v in [0, 255] casts via two's
        // complement so when the bytes travel through base64 → JS Uint8Array,
        // the unsigned reading recovers v exactly.
        return (byte) v;
    }
}
