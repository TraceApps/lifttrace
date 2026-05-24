/**
 * Rest-timer tone presets. Each preset defines:
 *   - `countdown(n)`: function returning { freq, ms, gain } for the beep at
 *     n seconds remaining (n is 3, 2, or 1)
 *   - `finale`: array of { freq, ms, gain, delayMs } — the sequence played at 0
 *
 * Kept synth-only (no audio files) so there's nothing to bundle and the
 * tones fit inside our existing AudioContext pipeline — matching the
 * "classic" beep behaviour that shipped originally.
 */

export const REST_TONES = [
  {
    id: 'classic',
    name: 'Classic',
    desc: '880 Hz beeps, higher chirp at 0',
    countdown: (n) => ({ freq: 660 + (4 - n) * 120, ms: 120, gain: 0.22 }),
    finale: [
      { freq: 1320, ms: 160, gain: 0.30, delayMs: 0 },
      { freq: 1760, ms: 180, gain: 0.32, delayMs: 200 },
    ],
  },
  {
    id: 'bells',
    name: 'Bells',
    desc: 'Soft musical chime, major-third finale',
    countdown: (n) => ({ freq: n === 3 ? 784 : n === 2 ? 880 : 988, ms: 220, gain: 0.18 }),
    finale: [
      { freq: 1047, ms: 260, gain: 0.26, delayMs: 0 },    // C6
      { freq: 1319, ms: 260, gain: 0.26, delayMs: 180 },  // E6
      { freq: 1568, ms: 340, gain: 0.28, delayMs: 360 },  // G6
    ],
  },
  {
    id: 'beeper',
    name: 'Beeper',
    desc: 'Sharp short square-wave beeps',
    countdown: (n) => ({ freq: n === 1 ? 1200 : 1000, ms: 70, gain: 0.20, type: 'square' }),
    finale: [
      { freq: 1400, ms: 90,  gain: 0.28, delayMs: 0,   type: 'square' },
      { freq: 1400, ms: 90,  gain: 0.28, delayMs: 140, type: 'square' },
      { freq: 1400, ms: 160, gain: 0.30, delayMs: 280, type: 'square' },
    ],
  },
  {
    id: 'gym',
    name: 'Gym',
    desc: 'Low thud countdown, rising horn at 0',
    countdown: (n) => ({ freq: 180 + (3 - n) * 25, ms: 140, gain: 0.28, type: 'triangle' }),
    finale: [
      { freq: 300, ms: 120, gain: 0.32, delayMs: 0,   type: 'sawtooth' },
      { freq: 450, ms: 140, gain: 0.32, delayMs: 120, type: 'sawtooth' },
      { freq: 600, ms: 260, gain: 0.34, delayMs: 260, type: 'sawtooth' },
    ],
  },
  {
    id: 'minimal',
    name: 'Minimal',
    desc: 'Single soft click on the 0 mark only',
    countdown: () => null, // no countdown beeps
    finale: [
      { freq: 760, ms: 90, gain: 0.22, delayMs: 0 },
    ],
  },
];

export function getTone(id) {
  return REST_TONES.find(t => t.id === id) || REST_TONES[0];
}
