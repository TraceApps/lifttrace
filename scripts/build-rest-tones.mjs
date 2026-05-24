#!/usr/bin/env node
/**
 * Pre-renders each REST_TONES finale to a WAV file in
 * android/app/src/main/res/raw/lt_tone_<id>.wav so backgrounded rest-timer
 * notifications can play the user's selected tone via the OS notification
 * channel — Web Audio doesn't run while the WebView is suspended.
 *
 * Synthesis matches the in-app `_tone()` function in restTimer.js:
 *   - 15ms linear attack from 0 to peak gain
 *   - Linear decay back to 0 over the remaining duration
 *   - Oscillator types: sine | square | triangle | sawtooth
 *
 * Re-run after editing src/lib/restTones.js. Wired into npm run android:debug
 * via a "prebuild:android-tones" hook so it runs before every Android build.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const TONES_SRC = resolve(REPO_ROOT, 'src/lib/restTones.js');
const OUT_DIR   = resolve(REPO_ROOT, 'android/app/src/main/res/raw');

const SAMPLE_RATE = 44100;
const BIT_DEPTH   = 16;
const CHANNELS    = 1;

// Tail padding so Android's MediaPlayer doesn't clip the very last sample
// when scheduling the notification (some devices truncate the final ~10ms).
const TAIL_PAD_MS = 50;

// ── Oscillators ───────────────────────────────────────────────────────────
// Each takes (t, freq) where t is seconds since note start, returns the
// raw waveform amplitude in [-1, 1]. The envelope is applied separately.
const OSC = {
  sine:     (t, f) => Math.sin(2 * Math.PI * f * t),
  square:   (t, f) => (Math.sin(2 * Math.PI * f * t) >= 0 ? 1 : -1),
  triangle: (t, f) => (2 / Math.PI) * Math.asin(Math.sin(2 * Math.PI * f * t)),
  sawtooth: (t, f) => 2 * ((f * t) - Math.floor(0.5 + f * t)),
};

/** Same envelope shape as Web Audio's `_tone()` in restTimer.js. */
function envelope(tSec, durationSec, peak) {
  const ATTACK = 0.015;
  if (tSec < 0 || tSec > durationSec) return 0;
  if (tSec < ATTACK) return (tSec / ATTACK) * peak;
  return peak - ((tSec - ATTACK) / (durationSec - ATTACK)) * peak;
}

/**
 * Render a tone's full backgrounded-fire sequence into Float32 PCM.
 *
 * If the tone has countdown beeps, the file is structured so that:
 *   - t=0      : countdown beep at 3-seconds-remaining
 *   - t=1000ms : countdown beep at 2-seconds-remaining
 *   - t=2000ms : countdown beep at 1-second-remaining
 *   - t=3000ms : finale (all delayMs offsets relative to this point)
 * The OS notification is scheduled at endTime − 3000ms so the audio
 * lands exactly on the timer hitting zero.
 *
 * Tones without countdown (e.g. 'minimal') just get the finale, scheduled
 * at endTime.
 *
 * Returns { samples, leadMs } so the JS scheduler knows the offset.
 */
function renderTone(tone) {
  const hasCountdown = !!(tone.countdown && tone.countdown(3));
  const leadMs = hasCountdown ? 3000 : 0;

  // Build a list of steps in absolute-time-from-start coordinates.
  const steps = [];
  if (hasCountdown) {
    for (const n of [3, 2, 1]) {
      const beep = tone.countdown(n);
      if (beep) {
        steps.push({
          ...beep,
          startMs: (3 - n) * 1000,   // 0, 1000, 2000
        });
      }
    }
  }
  for (const step of (tone.finale || [])) {
    steps.push({
      ...step,
      startMs: leadMs + (step.delayMs || 0),
    });
  }

  const totalMs = Math.max(...steps.map(s => s.startMs + s.ms)) + TAIL_PAD_MS;
  const total = Math.ceil((totalMs / 1000) * SAMPLE_RATE);
  const buf = new Float32Array(total);

  for (const step of steps) {
    const startSample = Math.floor((step.startMs / 1000) * SAMPLE_RATE);
    const endSample   = Math.floor(((step.startMs + step.ms) / 1000) * SAMPLE_RATE);
    const durSec      = step.ms / 1000;
    const osc         = OSC[step.type || 'sine'] || OSC.sine;
    const peak        = step.gain ?? 0.28;
    for (let i = startSample; i < endSample && i < total; i++) {
      const tInStep = (i - startSample) / SAMPLE_RATE;
      const env = envelope(tInStep, durSec, peak);
      buf[i] += env * osc(tInStep, step.freq);
    }
  }

  // Soft clip — additive synthesis can overshoot when notes overlap.
  for (let i = 0; i < total; i++) {
    if (buf[i] >  0.95) buf[i] =  0.95;
    if (buf[i] < -0.95) buf[i] = -0.95;
  }
  return { samples: buf, leadMs };
}

/** Write a PCM Float32 buffer as a 16-bit mono WAV file. */
function writeWav(samples, path) {
  const dataBytes = samples.length * (BIT_DEPTH / 8);
  const fileSize  = 44 + dataBytes;
  const buf = Buffer.alloc(fileSize);
  let p = 0;

  // RIFF header
  buf.write('RIFF', p); p += 4;
  buf.writeUInt32LE(fileSize - 8, p); p += 4;
  buf.write('WAVE', p); p += 4;

  // fmt chunk
  buf.write('fmt ', p); p += 4;
  buf.writeUInt32LE(16, p); p += 4;                              // subchunk size (PCM)
  buf.writeUInt16LE(1,  p); p += 2;                              // audio format (1 = PCM)
  buf.writeUInt16LE(CHANNELS, p); p += 2;
  buf.writeUInt32LE(SAMPLE_RATE, p); p += 4;
  buf.writeUInt32LE(SAMPLE_RATE * CHANNELS * (BIT_DEPTH / 8), p); p += 4; // byte rate
  buf.writeUInt16LE(CHANNELS * (BIT_DEPTH / 8), p); p += 2;     // block align
  buf.writeUInt16LE(BIT_DEPTH, p); p += 2;

  // data chunk
  buf.write('data', p); p += 4;
  buf.writeUInt32LE(dataBytes, p); p += 4;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(s * 32767), p);
    p += 2;
  }

  writeFileSync(path, buf);
}

// ── Parse REST_TONES out of src/lib/restTones.js ─────────────────────────
// We don't import the module — its arrow-function `countdown` keys would
// require a JS runtime that supports `import.meta` resolution against the
// project root. Instead, eval the array literal in a sandboxed Function
// scope. The file is project-controlled so eval is fine here.
async function loadTones() {
  // Easiest: dynamic import — Node 18+ handles ESM .js fine since the
  // package.json has "type": "module".
  const mod = await import(TONES_SRC);
  return mod.REST_TONES;
}

// ── Main ──────────────────────────────────────────────────────────────────
const tones = await loadTones();
mkdirSync(OUT_DIR, { recursive: true });

let total = 0;
for (const tone of tones) {
  if (!tone.finale || tone.finale.length === 0) {
    console.log(`  skip ${tone.id} (no finale)`);
    continue;
  }
  const { samples, leadMs } = renderTone(tone);
  const out = resolve(OUT_DIR, `lt_tone_${tone.id}.wav`);
  writeWav(samples, out);
  const ms = Math.round((samples.length / SAMPLE_RATE) * 1000);
  const kb = Math.round((44 + samples.length * 2) / 1024);
  console.log(`  ✓ lt_tone_${tone.id}.wav  (${ms}ms, ${kb}KB, lead=${leadMs}ms)`);
  total++;
}
console.log(`Rendered ${total} rest-timer tone(s) → ${OUT_DIR.replace(REPO_ROOT, '.')}`);
