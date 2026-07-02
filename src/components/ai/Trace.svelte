<script>
  import { onMount, onDestroy, tick } from 'svelte';
  import { writable } from 'svelte/store';
  import { fly, fade } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { _ } from 'svelte-i18n';
  import { portal } from '../../lib/portal.js';
  import { callAI, callAIProxy, AI_DEFAULT_MODELS } from '../../lib/aiChat.js';
  import { aiEnabled, aiEffectivelyEnabled, envLocks, aiProvider, aiApiKey, aiModel, aiBaseUrl, aiAssistantName, dateFormat, weightUnit, weeklyWorkoutGoal } from '../../stores/settings.js';
  import { currentUser } from '../../stores/auth.js';
  import { DB } from '../../lib/db.js';
  import { LtApi } from '../../lib/api.js';
  import { currentDate, todayLog, activeProgram, saveWorkout } from '../../stores/workout.js';
  import { isPlaying, currentTrack, getAudioForAnalyser } from '../../stores/player.js';
  import { showError } from '../../stores/toast.js';
  import { parseInput as smartParse, matchExercises, mergeIntoWorkout } from '../../lib/smartLogWorkout.js';
  import SmartLogModal from '../diary/SmartLogModal.svelte';
  import TraceFaceMusic from './TraceFaceMusic.svelte';
  // TraceFaceMusic is always mounted; the `playing` prop drives a CSS
  // transition that drops the headphones onto the head when music
  // starts and slips them off when it stops. Gate on both isPlaying
  // and a non-null currentTrack as defense-in-depth — pause flips
  // isPlaying false on its own, but some stop paths only clear
  // currentTrack, so checking both keeps the overlay in sync.
  $: _headphonesOn = $isPlaying && $currentTrack != null;
  // (Component is named "Trace" — the AI persona used across TraceApps.
  // Originally shipped as "LiftBot"; renamed for brand cohesion with NutriTrace.)

  let panelOpen = false;
  let messages = [];
  let input = '';
  let sending = false;
  let messagesEl;
  let pendingImages = [];
  let fileInput;
  let cameraInput;
  let showAttachMenu = false;
  let hasUnread = false;

  $: botName = $aiAssistantName || 'Trace';

  // Derive env-lock state from the global envLocks store (populated by
  // App.svelte at startup with the Bearer token attached). Local fetch
  // here didn't carry auth and 401'd on native server mode, leaving
  // serverHasKey=false and the chat refusing to send when AI was
  // configured via env vars. Same pattern as NutriTrace rc.33 fix.
  $: serverHasKey = !!$envLocks.ai;
  // 'oai-compat' provider can run keyless against local endpoints (Ollama
  // default), so it counts as "enabled" once a base URL is configured.
  $: isEnabled = $aiEffectivelyEnabled && ($aiApiKey || serverHasKey || ($aiProvider === 'oai-compat' && $aiBaseUrl));

  onMount(async () => {
    try {
      const res = await fetch('/api/ai/history', { credentials: 'include' });
      if (res.ok) messages = await res.json();
    } catch {}
  });

  // ── Frequency visualizer ring (reacts to currently playing music) ─────────
  // Two paths feed the same `freqBars` store:
  //   1. Web Audio AnalyserNode (music tracks via the audio element)
  //   2. Native LtRadioPlayer FFT events (radio streams on Capacitor —
  //      audio plays natively via ExoPlayer, the AnalyserNode can't see it)
  // Uses a writable store rather than `let freqBars = …`. Under Svelte 5
  // compat mode, reassigning a `let` array from inside a RAF callback
  // doesn't reliably re-trigger `{#each}`, so the bars rendered as a
  // frozen frame (looks "always at max" because the first non-zero frame
  // sticks). Stores update through `subscribe`, which is the same in
  // both Svelte 4 and 5.
  const VIZ_N = 32;
  const freqBars = writable(new Array(VIZ_N).fill(0));
  let _vizCtx = null;
  let _vizAnalyser = null;
  let _vizData = null;
  let _vizRaf = null;
  let _nativeFftUnsub = null;

  async function _setupViz() {
    // Native ExoPlayer path — radio streams on Capacitor. The audio doesn't
    // pass through the WebView's <audio> element so AnalyserNode sees
    // nothing; instead the LtRadioPlayer plugin emits real FFT data
    // captured by android.media.audiofx.Visualizer attached to the
    // ExoPlayer audio session.
    try {
      const { isAvailable, onFft } = await import('../../lib/native-player.js');
      if (isAvailable() && !_nativeFftUnsub) {
        _nativeFftUnsub = onFft(_onNativeFft);
      }
    } catch {}

    if (_vizAnalyser) {
      if (_vizCtx?.state === 'suspended') _vizCtx.resume().catch(() => {});
      if (!_vizRaf) _tickViz();
      return;
    }
    const a = getAudioForAnalyser();
    if (!a) return;
    try {
      _vizCtx = new (window.AudioContext || window.webkitAudioContext)();
      const node = _vizCtx.createMediaElementSource(a);
      _vizAnalyser = _vizCtx.createAnalyser();
      _vizAnalyser.fftSize = 64;           // 32 frequency bins
      _vizAnalyser.smoothingTimeConstant = 0.75;
      node.connect(_vizAnalyser);
      _vizAnalyser.connect(_vizCtx.destination);
      _vizData = new Uint8Array(_vizAnalyser.frequencyBinCount);
      _tickViz();
    } catch(e) {
      console.warn('[trace-viz] setup failed:', e?.message);
      _vizCtx = null; _vizAnalyser = null;
    }
  }


  function _tickViz() {
    if (!_vizAnalyser || !_vizData) { _vizRaf = null; return; }
    _vizAnalyser.getByteFrequencyData(_vizData);
    freqBars.set(Array.from(_vizData).map(v => v / 255));
    _vizRaf = requestAnimationFrame(_tickViz);
  }

  /**
   * Native FFT capture from FftAudioProcessor. Java side matches
   * Chromium's RealtimeAnalyser (fftSize=64, Blackman + window-gain
   * compensation, 1/N normalization, smoothingTimeConstant=0.75 on
   * linear magnitudes before dB, dB [-100, -30]).
   *
   * The FFT bytes are stored as a TARGET; a separate RAF loop
   * (_renderTick) eases the displayed bars toward the target every
   * frame. This decouples data updates from render updates so the ring
   * stays fluid even when the WebView's SVG render pipeline misses a
   * frame — the bars keep gliding toward the most recent FFT.
   */
  const _targetBars = new Float32Array(VIZ_N);
  const _displayBars = new Float32Array(VIZ_N);
  // RENDER_LERP at 0.08 over-dampened the Android visualizer: the Java
  // side already applies the W3C-spec 0.75 smoothing on linear magnitudes
  // BEFORE dB conversion (FftAudioProcessor.SMOOTHING), so a second lerp
  // layer of 8%/frame meant the displayed bars couldn't catch up to peaks
  // before the source decayed. The PWA path writes data directly to the
  // store with no second-layer smoothing — it relies entirely on
  // AnalyserNode's internal 0.75 STC. 0.35 keeps just enough easing to
  // hide occasional Capacitor-bridge frame drops while letting bars reach
  // ~93% of any peak within five 60Hz frames (~80ms).
  const RENDER_LERP = 0.35;
  let _renderRaf = null;

  function _onNativeFft(bins) {
    if (!bins || !bins.length) return;
    const n = Math.min(VIZ_N, bins.length);
    // bins are already Float32Array of 0..1 magnitudes (decoded by
    // _decodeFft in native-player.js, byte/255). Copy straight in.
    for (let i = 0; i < n; i++) _targetBars[i] = bins[i];
    for (let i = n; i < VIZ_N; i++) _targetBars[i] = 0;
    if (!_renderRaf) _renderTick();
  }

  function _renderTick() {
    // Lerp every bar 30% of the way toward its current target. Bars
    // settle within ~10 frames of any change. Cheaper than re-rendering
    // 32 SVG lines at the raw data rate, smoother than rendering at
    // exactly the data rate.
    const out = new Array(VIZ_N);
    let anyMoving = false;
    for (let i = 0; i < VIZ_N; i++) {
      const delta = _targetBars[i] - _displayBars[i];
      if (Math.abs(delta) > 0.001) {
        _displayBars[i] += delta * RENDER_LERP;
        anyMoving = true;
      } else if (_displayBars[i] !== _targetBars[i]) {
        _displayBars[i] = _targetBars[i];
      }
      out[i] = _displayBars[i];
    }
    freqBars.set(out);
    // Keep the loop alive as long as something's still moving OR data is
    // still arriving. _onNativeFft restarts the loop if it stops between
    // FFT frames.
    _renderRaf = anyMoving ? requestAnimationFrame(_renderTick) : null;
  }

  function _stopViz() {
    if (_vizRaf) { cancelAnimationFrame(_vizRaf); _vizRaf = null; }
    if (_renderRaf) { cancelAnimationFrame(_renderRaf); _renderRaf = null; }
    if (_nativeFftUnsub) { try { _nativeFftUnsub(); } catch {} _nativeFftUnsub = null; }
    _targetBars.fill(0);
    _displayBars.fill(0);
    freqBars.set(new Array(VIZ_N).fill(0));
  }

  $: if ($isPlaying) {
    setTimeout(_setupViz, 150);
  } else {
    _stopViz();
  }

  onDestroy(() => {
    _stopViz();
    try { _vizCtx?.close(); } catch {}
  });

  // ── Draggable FAB ──────────────────────────────────────────────────────────
  let fabPos = (() => {
    try {
      const pos = JSON.parse(localStorage.getItem('lt:aiFabPos') || 'null');
      if (!pos) return null;
      // Clamp to current viewport so it can't be off-screen
      pos.x = Math.max(0, Math.min(window.innerWidth - 60, pos.x));
      pos.y = Math.max(0, Math.min(window.innerHeight - 60, pos.y));
      return pos;
    } catch { return null; }
  })();

  // Re-clamp on resize
  function _clampFab() {
    if (!fabPos) return;
    fabPos = {
      x: Math.max(0, Math.min(window.innerWidth - 60, fabPos.x)),
      y: Math.max(0, Math.min(window.innerHeight - 60, fabPos.y)),
    };
  }
  if (typeof window !== 'undefined') window.addEventListener('resize', _clampFab);
  let hasDragged = false;

  $: fabStyle = fabPos
    ? `left:${fabPos.x}px; top:${fabPos.y}px; right:auto; bottom:auto;`
    : '';

  // ── Hold-to-record (Smart Log via Trace FAB) ───────────────────────────
  // Press + hold for 700ms → FAB turns red, face morphs to mic, beep +
  // (native) haptic, Web Speech API starts. Release within 100px of the
  // FAB center → commit → parse → open SmartLogModal pre-parsed.
  // Slide > 100px from center → cancel-preview (FAB greys). Release
  // there → abort. Move > 6px before 700ms → drag mode (existing behavior).
  let recordingMode = false;
  let cancelPreview = false;
  let recordingStartedAt = 0;
  const HOLD_THRESHOLD_MS = 700;
  const CANCEL_RADIUS_PX = 100;
  let holdTimer = null;
  let _fabCenterX = 0;
  let _fabCenterY = 0;
  let _commitNextTranscript = false;

  // Smart Log modal state — mounted globally from this component
  let showSmartLog = false;
  let smartLogPreParsed = null;
  let smartLogText = '';

  // Smart Log is available when Trace itself is available
  $: smartLogAvailable = isEnabled;

  let _audioCtx = null;
  function _beep(frequency, durationMs) {
    try {
      if (!_audioCtx) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        _audioCtx = new Ctx();
      }
      const ctx = _audioCtx;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = frequency;
      osc.type = 'sine';
      const now = ctx.currentTime;
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.18, now + 0.012);
      gain.gain.linearRampToValueAtTime(0, now + (durationMs / 1000));
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + (durationMs / 1000) + 0.02);
    } catch {}
  }

  function _vibrate(ms) {
    import('../../lib/haptics.js').then(m => m.haptic(ms)).catch(() => {});
  }

  async function _startRecording() {
    if (!smartLogAvailable) return;
    recordingMode = true;
    cancelPreview = false;
    recordingStartedAt = Date.now();
    _commitNextTranscript = true;
    _vibrate(30);
    _beep(1000, 80);

    // PWA: Web Speech API
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      recordingMode = false;
      showError($_('common.errors.voice_unsupported'));
      return;
    }
    try {
      const rec = new SR();
      rec.continuous = false;
      rec.interimResults = false;
      rec.lang = navigator.language || 'en-US';
      rec.onresult = async (e) => {
        if (!_commitNextTranscript) return;
        const transcript = e.results[0]?.[0]?.transcript || '';
        if (transcript) await _processTranscript(transcript);
        else showError("Didn't catch that — try again");
      };
      rec.onerror = (e) => {
        if (_commitNextTranscript) showError('Voice error: ' + (e.error || 'unknown'));
      };
      window.__traceHoldRec = rec;
      rec.start();
    } catch (e) {
      recordingMode = false;
      showError('Could not start mic: ' + e.message);
    }
  }

  function _stopRecording(commit) {
    if (!recordingMode) return;
    recordingMode = false;
    cancelPreview = false;
    if (!commit) _commitNextTranscript = false;
    _vibrate(15);
    _beep(commit ? 600 : 350, 80);
    if (window.__traceHoldRec) {
      try { commit ? window.__traceHoldRec.stop() : window.__traceHoldRec.abort(); } catch {}
      window.__traceHoldRec = null;
    }
  }

  async function _processTranscript(text) {
    if (!text?.trim()) return;
    smartLogText = text;
    try {
      const parsed = await smartParse(text);
      if (!parsed.exercises?.length) {
        showError(`Couldn't find any exercises in "${text}"`);
        return;
      }
      smartLogPreParsed = await matchExercises(parsed);
      showSmartLog = true;
    } catch (e) {
      showError('Smart Log parse failed: ' + (e.message || 'unknown error'));
    }
  }

  async function handleSmartLogSave(mergedExercises) {
    await saveWorkout($currentDate, { ...($todayLog || {}), exercises: mergedExercises });
    // Reset pre-parsed state so next open reverts to normal modal mode
    smartLogPreParsed = null;
    smartLogText = '';
  }

  function startDrag(e) {
    hasDragged = false;
    const startX = e.clientX;
    const startY = e.clientY;
    const baseX = fabPos ? fabPos.x : window.innerWidth  - 76;
    const baseY = fabPos ? fabPos.y : window.innerHeight - 160;

    // Capture FAB center for cancel-preview distance calc
    const fabEl = e.currentTarget;
    if (fabEl?.getBoundingClientRect) {
      const r = fabEl.getBoundingClientRect();
      _fabCenterX = r.left + r.width / 2;
      _fabCenterY = r.top + r.height / 2;
    }

    // Start hold-to-record timer in parallel with drag detection
    if (smartLogAvailable && !panelOpen) {
      holdTimer = setTimeout(() => {
        if (!hasDragged) _startRecording();
      }, HOLD_THRESHOLD_MS);
    }

    function move(ev) {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      // Enter drag mode only if moved BEFORE recording started
      if (!recordingMode && !hasDragged && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) {
        hasDragged = true;
        if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
      }
      if (hasDragged) {
        fabPos = {
          x: Math.max(8, Math.min(window.innerWidth  - 64, baseX + dx)),
          y: Math.max(8, Math.min(window.innerHeight - 64, baseY + dy)),
        };
        return;
      }
      // While recording, check distance from FAB center for cancel preview
      if (recordingMode) {
        const fdx = ev.clientX - _fabCenterX;
        const fdy = ev.clientY - _fabCenterY;
        const dist = Math.sqrt(fdx * fdx + fdy * fdy);
        const shouldCancel = dist > CANCEL_RADIUS_PX;
        if (shouldCancel !== cancelPreview) {
          cancelPreview = shouldCancel;
          if (shouldCancel) _vibrate(10);
        }
      }
    }
    function up() {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
      if (hasDragged) {
        localStorage.setItem('lt:aiFabPos', JSON.stringify(fabPos));
      } else if (recordingMode) {
        _stopRecording(!cancelPreview);
      }
    }
    function cancel() {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
      if (recordingMode) _stopRecording(false);
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
  }

  function handleFabClick() {
    // Tap opens chat. Suppress when a recording gesture just ran.
    if (hasDragged || recordingMode) return;
    panelOpen = !panelOpen;
    if (panelOpen) hasUnread = false;
  }

  // ── Image attachment ───────────────────────────────────────────────────────
  async function handleFiles(e) {
    const files = Array.from(e.target.files || []);
    for (const f of files) {
      if (!f.type.startsWith('image/')) continue;
      const dataUrl = await fileToDataUrl(f);
      pendingImages = [...pendingImages, { dataUrl, mediaType: f.type }];
    }
    e.target.value = '';
  }
  function fileToDataUrl(file) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload  = () => res(r.result);
      r.onerror = rej;
      r.readAsDataURL(file);
    });
  }
  function removeImage(i) {
    pendingImages = pendingImages.filter((_, idx) => idx !== i);
  }

  // ── Auto-scroll ────────────────────────────────────────────────────────────
  function scrollBottom(instant = false) {
    if (messagesEl) messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: instant ? 'instant' : 'smooth' });
  }

  // ── Quick asks ─────────────────────────────────────────────────────────────
  const QUICK_ASKS = [
    "Generate today's workout",
    'How should I warm up for squats?',
    'Tips for progressive overload',
    'Help me break a bench plateau',
  ];
  function quickAsk(q) { input = q; send(); }

  // ── Workout plan extraction ────────────────────────────────────────────────
  // System prompt teaches Trace to format generated workouts as a single
  // `PLAN: ...` line in Smart-Add syntax. After every assistant reply we
  // scan for that line; if present, the message gets an "Use This Workout"
  // button that hands the plan text to the existing Smart-Add parser →
  // matcher → SmartLogModal flow. Zero new modals, just plumbing.
  const PLAN_RX = /^\s*PLAN:\s*(.+)$/im;
  function _extractPlan(content) {
    if (!content) return null;
    const text = typeof content === 'string'
      ? content
      : (Array.isArray(content) ? content.map(p => p?.text || '').join(' ') : '');
    const m = text.match(PLAN_RX);
    return m ? m[1].trim() : null;
  }
  async function useGeneratedPlan(planText) {
    if (!planText) return;
    await _processTranscript(planText);
  }

  // ── Time formatting ────────────────────────────────────────────────────────
  function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const now = new Date();
    const timeStr = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    if (d.toDateString() === now.toDateString()) return timeStr;
    const dateStr = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return `${dateStr} · ${timeStr}`;
  }

  // ── Send ───────────────────────────────────────────────────────────────────
  /** USER PROFILE block for the system prompt — always-available context
   *  so Trace can answer "what's my name / age / gender" without a tool
   *  round-trip and won't hallucinate substitutes. Pulls from $currentUser
   *  first (server-backed) and falls back to the wizard-written settings
   *  (single-user / native standalone). */
  function buildUserProfile() {
    const u = $currentUser || {};
    const _nick   = (u.nickname || '').trim() || (DB.getSetting('localUserNickname', '') || '').trim();
    const _full   = (u.full_name || '').trim() || (DB.getSetting('localUserName', '') || '').trim();
    const _name   = (_full && _full !== 'Local User') ? _full : '';
    const _dob    = u.birthday || DB.getSetting('dob', '') || '';
    const _gender = u.gender   || DB.getSetting('gender', '') || '';
    let _age = null;
    if (_dob) {
      const ms = Date.now() - new Date(_dob).getTime();
      const a  = Math.floor(ms / (365.25 * 24 * 3600 * 1000));
      if (a > 0 && a < 130) _age = a;
    }
    const bits = [];
    if (_name)              bits.push(`name: ${_name}`);
    if (_nick && _nick !== _name) bits.push(`nickname: ${_nick}`);
    if (_age != null)       bits.push(`age: ${_age}`);
    if (_dob)               bits.push(`dob: ${_dob}`);
    if (_gender)            bits.push(`gender: ${_gender}`);
    return bits.join(', ');
  }

  async function buildContext() {
    const parts = [];
    try {
      // Today's workout — warm-ups excluded so "work done" means work done.
      // RPE appended per set when present (e.g. "225×5 @8") so the coach
      // can spot fatigue patterns.
      const log = $todayLog;
      if (log && log.exercises?.length) {
        const exList = (log.exercises || []).map(e => {
          const sets = (e.sets || []).filter(s => s.completed && !s.warmup);
          const setStr = sets.map(s => {
            const rpe = (s.rpe != null && s.rpe !== '') ? ` @${s.rpe}` : '';
            return `${s.weight}${$weightUnit}×${s.reps}${rpe}`;
          }).join(', ');
          const warmups = (e.sets || []).filter(s => s.completed && s.warmup).length;
          const wu = warmups ? ` (+ ${warmups} warm-up)` : '';
          return `  - ${e.exercise_name}: ${setStr || 'no sets completed'}${wu}`;
        }).join('\n');
        parts.push(`TODAY'S WORKOUT (${$currentDate}):\n${log.name ? `Name: ${log.name}\n` : ''}${exList}`);
      }

      // Trainer prescription for today, if any
      try {
        const pxRes = await fetch(`/api/prescriptions/my/${$currentDate}`, { credentials: 'include' });
        if (pxRes.ok) {
          const px = await pxRes.json();
          if (px && (px.name || px.template_name)) {
            parts.push(`COACH PRESCRIPTION TODAY: ${px.template_name || px.name}${px.trainer_name ? ` — prescribed by ${px.trainer_name}` : ''}${px.notes ? `\nNotes: ${px.notes}` : ''}`);
          }
        }
      } catch {}

      // Active program + its templates
      if ($activeProgram?.id) {
        try {
          const pRes = await fetch(`/api/programs/${$activeProgram.id}`, { credentials: 'include' });
          if (pRes.ok) {
            const p = await pRes.json();
            const tplList = (p.templates || []).slice(0, 8).map(t => {
              const dayLabel = t.day_label ? ` (${t.day_label})` : '';
              const exNames = (t.exercises || []).slice(0, 6).map(e => e.exercise_name).filter(Boolean).join(', ');
              return `  - ${t.name}${dayLabel}${exNames ? `: ${exNames}` : ''}`;
            }).join('\n');
            parts.push(`ACTIVE PROGRAM: ${p.name}${p.goal ? ` — goal: ${p.goal}` : ''}\n${tplList}`);
          }
        } catch {}
      }

      // Last 14 days of workouts (keeps context small but covers ~2 weeks).
      // Warm-ups excluded from top-set selection. RPE appended when logged.
      try {
        const wRes = await fetch('/api/workout/recent?limit=14', { credentials: 'include' });
        if (wRes.ok) {
          const recent = await wRes.json();
          const past = (recent || []).filter(r => r.date !== $currentDate && (r.exercises || []).some(e => (e.sets || []).some(s => s.completed && !s.warmup)));
          if (past.length) {
            const lines = past.slice(0, 14).map(r => {
              const exSummary = (r.exercises || []).map(e => {
                const top = (e.sets || []).filter(s => s.completed && !s.warmup)
                  .reduce((best, s) => (!best || (s.weight || 0) > (best.weight || 0)) ? s : best, null);
                if (!top) return null;
                const rpe = (top.rpe != null && top.rpe !== '') ? ` @${top.rpe}` : '';
                return `${e.exercise_name} ${top.weight}${$weightUnit}×${top.reps}${rpe}`;
              }).filter(Boolean).slice(0, 6).join(', ');
              return `  - ${r.date}${r.name ? ` "${r.name}"` : ''}: ${exSummary || '(logged, no top sets)'}`;
            });
            parts.push(`RECENT WORKOUTS:\n${lines.join('\n')}`);
          }
        }
      } catch {}

      // Muscle recovery summary — hours since each muscle was last hit
      // with a completed non-warmup set. Same computation as the
      // Statistics > Muscle Recovery body diagram, so Trace and the UI
      // agree on what's fresh vs. fatigued. Lets Trace's "Generate
      // today's workout" loop make sensible recovery-aware choices
      // without having to re-derive that from the raw RECENT WORKOUTS
      // dump above.
      try {
        const [recRes, exRes] = await Promise.all([
          fetch('/api/workout/recent?limit=21', { credentials: 'include' }),
          fetch('/api/exercises', { credentials: 'include' }),
        ]);
        if (recRes.ok && exRes.ok) {
          const recent = await recRes.json();
          const exList = await exRes.json();
          const { computeMuscleRecovery, freshnessFor } = await import('../../lib/muscle-recovery.js');
          const rec = computeMuscleRecovery(recent || [], exList || [], 7);
          const labelHours = h => {
            if (h == null) return 'no recent work';
            if (h < 1)  return 'just now';
            if (h < 24) return `${h}h ago`;
            const d = Math.round(h / 24);
            return `${d}d ago`;
          };
          const lines = Object.entries(rec)
            .map(([muscle, info]) => {
              const state = freshnessFor(info.hoursAgo).label;
              return `  - ${muscle}: ${state} (${labelHours(info.hoursAgo)}, ${info.sets} sets)`;
            });
          if (lines.length) parts.push(`MUSCLE RECOVERY (past 7d):\n${lines.join('\n')}`);
        }
      } catch {}

      // Body stats today + trend from last 30 days
      try {
        const bsRes = await fetch(`/api/body-stats/${$currentDate}`, { credentials: 'include' });
        if (bsRes.ok) {
          const bs = await bsRes.json();
          const stats = bs.stats ? (typeof bs.stats === 'string' ? JSON.parse(bs.stats) : bs.stats) : {};
          const entries = Object.entries(stats).filter(([,v]) => v != null && v !== '');
          if (entries.length) {
            parts.push(`BODY STATS (${$currentDate}):\n${entries.map(([k,v]) => `  - ${k}: ${v}`).join('\n')}`);
          }
        }
      } catch {}
      try {
        const end = $currentDate;
        const d = new Date(end + 'T12:00:00');
        d.setDate(d.getDate() - 30);
        const start = d.toISOString().slice(0, 10);
        const rangeRes = await fetch(`/api/body-stats/range?start=${start}&end=${end}`, { credentials: 'include' });
        if (rangeRes.ok) {
          const rows = await rangeRes.json();
          const weights = (rows || [])
            .map(r => ({ date: r.date, w: (typeof r.stats === 'string' ? JSON.parse(r.stats) : r.stats)?.weight }))
            .filter(x => x.w != null && x.w !== '');
          if (weights.length > 1) {
            const first = weights[0].w, last = weights[weights.length - 1].w;
            const delta = (last - first).toFixed(1);
            parts.push(`BODY WEIGHT TREND (last 30d): ${first}→${last} ${$weightUnit} (${delta >= 0 ? '+' : ''}${delta})`);
          }
        }
      } catch {}

      // Recent PRs
      try {
        const prRes = await fetch('/api/stats/records', { credentials: 'include' });
        if (prRes.ok) {
          const records = await prRes.json();
          if (records.length > 0) {
            const top = records.slice(0, 10).map(r => `  - ${r.exercise_name}: ${r.max_weight}${$weightUnit}`).join('\n');
            parts.push(`PERSONAL RECORDS (top 10):\n${top}`);
          }
        }
      } catch {}

      // Weekly goal + frequency for last 4 weeks
      try {
        parts.push(`WEEKLY GOAL: ${$weeklyWorkoutGoal} workouts/week`);
        const endDate = new Date($currentDate + 'T12:00:00');
        const startDate = new Date(endDate);
        startDate.setDate(startDate.getDate() - 28);
        const s = startDate.toISOString().slice(0, 10);
        const e = endDate.toISOString().slice(0, 10);
        const freqRes = await fetch(`/api/stats/frequency?start=${s}&end=${e}`, { credentials: 'include' });
        if (freqRes.ok) {
          const data = await freqRes.json();
          if (Array.isArray(data) && data.length) {
            const weeks = data.slice(-4).map(w => `${w.count}`).join(', ');
            parts.push(`FREQUENCY (last 4 weeks): ${weeks} workouts/week`);
          }
        }
      } catch {}

      // Streaks
      try {
        const stRes = await fetch('/api/stats/streaks', { credentials: 'include' });
        if (stRes.ok) {
          const s = await stRes.json();
          parts.push(`STREAKS: current ${s.currentStreak} days, longest ${s.longestStreak} days, total ${s.totalWorkouts} workouts`);
        }
      } catch {}
    } catch {}
    return parts.length ? '\n\n--- USER DATA ---\n' + parts.join('\n\n') : '';
  }

  async function send() {
    if ((!input.trim() && pendingImages.length === 0) || sending) return;
    const text = input.trim();
    input = '';

    let content;
    if (pendingImages.length > 0) {
      content = [
        ...pendingImages.map(img => ({ type: 'image', dataUrl: img.dataUrl })),
        ...(text ? [{ type: 'text', text }] : [{ type: 'text', text: 'Please look at this.' }]),
      ];
    } else {
      content = text;
    }

    const userMsg = { role: 'user', content, time: new Date().toISOString() };
    messages = [...messages, userMsg];
    pendingImages = [];
    sending = true;
    await tick();
    scrollBottom();

    fetch('/api/ai/history', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(userMsg),
    }).catch(() => {});

    try {
      const ctx = await buildContext();
      const profile = buildUserProfile();
      const systemPrompt = `You are ${botName}, a knowledgeable and motivating weightlifting AI coach inside the LiftTrace app.
You help users with workout programming, exercise form, progressive overload, recovery, and reaching their fitness goals.
Be concise, practical, and encouraging. Use simple language. If asked about exercise form, be specific about cues.
Keep responses under 200 words unless more detail is specifically requested.
The user tracks weights in ${$weightUnit}.

USER PROFILE (always-available context — these are facts about the user, not numbers to hallucinate around. When asked "what's my name / age / gender", answer directly from this block. Don't say you don't know.):
${profile || '(no profile data set yet — politely tell the user to fill it in via Settings → My Profile if they ask about their name, age, or gender)'}

Data annotations you may see:
- "225lbs×5 @8" — the @N suffix is RPE (Rate of Perceived Exertion, 6-10). Higher RPE = closer to failure. Rising RPE on the same weight across sessions indicates accumulating fatigue; consider suggesting a deload.
- "(+ 2 warm-up)" — warm-up sets done in addition to the logged working sets. Warm-ups are already excluded from volume / PR counts.
- "COACH PRESCRIPTION TODAY" — the user has a trainer who assigned this workout; stay within that plan unless they ask for variations.

Workout generation:
When the user asks you to generate a workout (today's session, a routine, "what should I do", etc.), pick exercises that fit their recent recovery (avoid hammering muscles trained in the last 24-48h based on the RECENT WORKOUTS context) and align with their ACTIVE PROGRAM if one is set. Prescribe weights at about 70-80% of their recent top sets for that lift; default to "BW" for bodyweight movements they've used before.

Format the workout as ONE plain text line beginning with the literal token "PLAN:" — no markdown, no code fences, no asterisks. Use comma-separated exercise entries in this shape:
  PLAN: <exercise> <sets>x<reps> @ <weight><unit>, <exercise> <sets>x<reps> @ <weight><unit>, ...
Examples:
  PLAN: bench press 3x5 @ 185lbs, OHP 3x8 @ 95lbs, dips 3x10 @ BW, tricep pushdown 3x12 @ 50lbs
  PLAN: squat 5x5 @ 225lbs, RDL 3x8 @ 185lbs, leg press 3x12 @ 270lbs, calf raise 4x15 @ BW

Follow the PLAN line with a SHORT rationale (1-3 sentences) explaining the choices. The app surfaces a one-tap "Use This Workout" button under any reply containing a PLAN line, so the line MUST be parseable Smart-Add syntax. If the user is asking general questions (form, recovery, programming theory) DO NOT include a PLAN line — only emit one when they're actually asking for a workout to perform.${ctx}`;

      const apiMessages = messages
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .slice(-20);

      let reply;
      // OpenAI-compatible endpoints (Ollama etc.) can run keyless — gate on
      // either an API key OR an oai-compat config. Otherwise fall through
      // to the server-proxy path (env-locked install).
      const hasClientConfig = $aiApiKey || ($aiProvider === 'oai-compat' && $aiBaseUrl);
      if (hasClientConfig) {
        reply = await callAI({
          provider: $aiProvider,
          apiKey: $aiApiKey,
          model: $aiModel || AI_DEFAULT_MODELS[$aiProvider],
          baseUrl: $aiBaseUrl || undefined,
          messages: apiMessages,
          systemPrompt,
        });
      } else {
        reply = await callAIProxy({ messages: apiMessages, systemPrompt });
      }

      const aMsg = { role: 'assistant', content: reply, time: new Date().toISOString() };
      messages = [...messages, aMsg];

      if (!panelOpen) hasUnread = true;

      fetch('/api/ai/history', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(aMsg),
      }).catch(() => {});
    } catch(e) {
      messages = [...messages, { role: 'assistant', content: `Sorry, I couldn't respond: ${e.message}`, time: new Date().toISOString() }];
    }

    sending = false;
    await tick();
    scrollBottom();
  }

  async function clearHistory() {
    messages = [];
    fetch('/api/ai/history', { method: 'DELETE', credentials: 'include' }).catch(() => {});
  }

  function onKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  }

  // Render helpers
  function getText(content) {
    if (typeof content === 'string') return content;
    return content.filter(p => p.type === 'text').map(p => p.text).join('\n');
  }
  function getImages(content) {
    if (typeof content === 'string') return [];
    return content.filter(p => p.type === 'image');
  }
</script>

{#if isEnabled}
  <div use:portal>
    <!-- ── FAB ────────────────────────────────────────────────────────────── -->
    <!-- svelte-ignore a11y-no-static-element-interactions -->
    <div
      class="lb-fab"
      class:panel-open={panelOpen}
      class:has-unread={hasUnread}
      class:recording={recordingMode}
      class:cancel-preview={cancelPreview}
      style={fabStyle}
      on:pointerdown={startDrag}
      on:click={handleFabClick}
      on:keydown={e => e.key === 'Enter' && handleFabClick()}
      role="button"
      tabindex="0"
      aria-label={$_('trace.fab_label')}
      title={$_('trace.fab_tooltip')}
    >
      {#if $isPlaying && !recordingMode}
        <svg class="lb-viz-ring" viewBox="0 0 128 128" aria-hidden="true" transition:fade={{ duration: 400 }}>
          <defs>
            <filter id="lb-viz-glow" x="-60%" y="-60%" width="220%" height="220%">
              <feGaussianBlur in="SourceGraphic" stdDeviation="1.8" result="blur" />
              <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
          </defs>
          <g filter="url(#lb-viz-glow)">
            {#each $freqBars as v, i}
              {@const angle = (i / VIZ_N) * Math.PI * 2 - Math.PI / 2}
              {@const r1 = 34}
              {@const barLen = v * 20}
              {#if barLen > 0.5}
                <line
                  x1={64 + r1 * Math.cos(angle)}
                  y1={64 + r1 * Math.sin(angle)}
                  x2={64 + (r1 + barLen) * Math.cos(angle)}
                  y2={64 + (r1 + barLen) * Math.sin(angle)}
                  stroke="currentColor"
                  stroke-width="2.5"
                  stroke-linecap="round"
                  opacity={0.3 + v * 0.7}
                />
              {/if}
            {/each}
          </g>
        </svg>
      {/if}
      {#if recordingMode}
        <span class="material-symbols-rounded" style="font-size:30px;color:#fff;position:relative;z-index:1">mic</span>
      {:else if panelOpen}
        <span class="material-symbols-rounded" style="font-size:26px;position:relative;z-index:1">close</span>
      {:else}
        <div class="fab-robot-wrap"><TraceFaceMusic size={38} playing={_headphonesOn} /></div>
      {/if}
      {#if hasUnread && !panelOpen && !recordingMode}
        <div class="lb-badge" transition:fade={{ duration: 120 }}></div>
      {/if}
    </div>

    {#if recordingMode}
      <div class="lb-record-hint" transition:fade={{ duration: 140 }}>
        {cancelPreview ? 'Release to cancel' : 'Listening… release to log'}
      </div>
    {/if}

    <!-- ── Panel ──────────────────────────────────────────────────────────── -->
    {#if panelOpen}
      <!-- svelte-ignore a11y-no-static-element-interactions -->
      <div class="lb-backdrop" transition:fade={{ duration: 200 }} on:click={() => panelOpen = false}></div>
      <aside
        class="lb-panel"
        transition:fly={{ y: 600, duration: 320, easing: cubicOut }}
      >
        <div class="lb-drag-handle"></div>

        <div class="lb-header">
          <div class="lb-header-brand">
            <div class="lb-avatar">
              <TraceFaceMusic size={28} playing={_headphonesOn} />
            </div>
            <div>
              <div class="lb-header-name">{botName}</div>
              <div class="lb-header-sub">AI Lifting Coach</div>
            </div>
          </div>
          <div class="lb-header-actions">
            <button class="lb-hdr-btn" on:click={clearHistory} title={$_('trace.clear_conversation')}>
              <span class="material-symbols-rounded">delete_sweep</span>
            </button>
            <button class="lb-hdr-btn" on:click={() => panelOpen = false} title={$_('common.close')}>
              <span class="material-symbols-rounded">close</span>
            </button>
          </div>
        </div>

        <div class="lb-messages" bind:this={messagesEl}>
          {#if messages.length === 0}
            <div class="lb-welcome">
              <div class="lb-welcome-avatar">
                <TraceFaceMusic size={52} playing={_headphonesOn} />
              </div>
              <div class="lb-welcome-name">{botName}</div>
              <p class="lb-welcome-desc">Ask me anything — workout programming, exercise form, progressive overload, recovery. You can attach photos for form checks!</p>
              <div class="lb-chips">
                {#each QUICK_ASKS as q}
                  <button class="lb-chip" on:click={() => quickAsk(q)}>{q}</button>
                {/each}
              </div>
            </div>
          {/if}

          {#each messages as msg}
            {@const plan = msg.role === 'assistant' ? _extractPlan(msg.content) : null}
            <div class="lb-msg" class:user={msg.role === 'user'}>
              {#if msg.role === 'assistant'}
                <div class="lb-msg-avatar">
                  <TraceFaceMusic size={22} playing={_headphonesOn} />
                </div>
              {/if}
              <div class="lb-msg-body">
                <div class="lb-bubble">
                  {#each getImages(msg.content) as img}
                    <img class="lb-msg-img" src={img.dataUrl} alt="attachment" />
                  {/each}
                  {#if getText(msg.content)}{getText(msg.content)}{/if}
                </div>
                {#if plan}
                  <button class="lb-plan-apply" on:click={() => useGeneratedPlan(plan)}>
                    <span class="material-symbols-rounded">fitness_center</span>
                    Use This Workout
                  </button>
                {/if}
                {#if msg.time}
                  <span class="lb-time">{fmtTime(msg.time)}</span>
                {/if}
              </div>
            </div>
          {/each}

          {#if sending}
            <div class="lb-msg">
              <div class="lb-msg-avatar">
                <TraceFaceMusic size={22} playing={_headphonesOn} />
              </div>
              <div class="lb-msg-body">
                <div class="lb-bubble lb-typing">
                  <span class="lb-dot"></span>
                  <span class="lb-dot"></span>
                  <span class="lb-dot"></span>
                </div>
              </div>
            </div>
          {/if}
        </div>

        {#if pendingImages.length > 0}
          <div class="lb-img-preview">
            {#each pendingImages as img, i}
              <div class="lb-preview-thumb">
                <img src={img.dataUrl} alt="" />
                <button class="lb-img-remove" on:click={() => removeImage(i)}>
                  <span class="material-symbols-rounded" style="font-size:14px">close</span>
                </button>
              </div>
            {/each}
          </div>
        {/if}

        <div class="lb-input-bar">
          <div class="lb-attach-wrap">
            <button class="lb-attach-btn" on:click={() => showAttachMenu = !showAttachMenu} title={$_('trace.attach_image')}>
              <span class="material-symbols-rounded" style="font-size:20px">add_photo_alternate</span>
            </button>
            {#if showAttachMenu}
              <div class="lb-attach-menu" transition:fade={{ duration: 120 }}>
                <button class="lb-attach-option" on:click={() => { showAttachMenu = false; cameraInput.click(); }}>
                  <span class="material-symbols-rounded">photo_camera</span> Camera
                </button>
                <button class="lb-attach-option" on:click={() => { showAttachMenu = false; fileInput.click(); }}>
                  <span class="material-symbols-rounded">image</span> Gallery
                </button>
              </div>
            {/if}
          </div>
          <input bind:this={fileInput}   type="file" accept="image/*" multiple style="display:none" on:change={handleFiles} />
          <input bind:this={cameraInput} type="file" accept="image/*" capture="environment" style="display:none" on:change={handleFiles} />
          <textarea
            class="lb-textarea"
            rows="1"
            bind:value={input}
            on:keydown={onKey}
            placeholder={$_('trace.ask_placeholder')}
            disabled={sending}
          ></textarea>
          <button
            class="lb-send-btn"
            on:click={send}
            disabled={sending || (!input.trim() && pendingImages.length === 0)}
          >
            <span class="material-symbols-rounded" style="font-size:20px">send</span>
          </button>
        </div>
      </aside>
    {/if}
  </div>
{/if}

<!-- Smart Log modal — opens when a hold-to-record gesture produces parsed items -->
<SmartLogModal
  bind:open={showSmartLog}
  date={$currentDate}
  existingLog={$todayLog}
  preParsedMatches={smartLogPreParsed}
  preParsedSourceText={smartLogText}
  onSave={handleSmartLogSave}
/>

<style>
  /* ═══ FAB ═══════════════════════════════════════════════════════════════ */
  .lb-fab {
    position: fixed;
    right: 20px;
    bottom: calc(var(--nav-h) + var(--safe-bottom, 0px) + 20px);
    width: 60px; height: 60px;
    border-radius: 50%;
    background: linear-gradient(135deg, var(--accent), var(--accent-2, var(--accent)));
    background-size: 300% 300%;
    animation: lb-gradient-shift 8s ease infinite, lb-ring-pulse 2.6s ease-in-out infinite;
    color: var(--accent-text, #fff);
    border: 1px solid rgba(255,255,255,0.25);
    cursor: pointer;
    z-index: 400;
    display: flex; align-items: center; justify-content: center;
    box-shadow: 0 8px 32px rgba(0,0,0,0.35);
    backdrop-filter: blur(12px);
    transition: transform 0.18s ease, box-shadow 0.18s ease;
    touch-action: none;
    user-select: none;
    -webkit-user-select: none;
  }
  /* Glass highlight */
  .lb-fab::before {
    content: '';
    position: absolute; inset: 0;
    border-radius: 50%;
    background: radial-gradient(circle at 30% 25%, rgba(255,255,255,0.28), transparent 55%);
    pointer-events: none;
  }
  .lb-fab:hover {
    transform: scale(1.08);
    box-shadow: 0 8px 32px rgba(0,0,0,0.45), 0 0 0 8px var(--accent-dim);
  }
  .lb-fab:active    { transform: scale(0.94); }
  .lb-fab.panel-open { animation: lb-gradient-shift 8s ease infinite; }
  .lb-fab.recording {
    background: var(--danger, #FF5C5C);
    animation: lb-record-pulse 1.2s ease-in-out infinite;
    box-shadow: 0 0 24px color-mix(in srgb, var(--danger) 70%, transparent);
  }
  .lb-fab.recording.cancel-preview {
    background: var(--text-3);
    animation: none;
    opacity: 0.6;
    box-shadow: none;
  }
  @keyframes lb-record-pulse {
    0%, 100% { transform: scale(1); }
    50%      { transform: scale(1.08); }
  }
  .lb-record-hint {
    position: fixed;
    right: 20px;
    bottom: calc(var(--nav-h) + var(--safe-bottom, 0px) + 88px);
    padding: 8px 14px;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    font-size: 12px; font-weight: 600; color: var(--text-1);
    box-shadow: 0 4px 16px rgba(0,0,0,0.3);
    pointer-events: none;
    z-index: 99;
    white-space: nowrap;
  }

  @keyframes lb-gradient-shift {
    0%   { background-position: 0% 50%; }
    50%  { background-position: 100% 50%; }
    100% { background-position: 0% 50%; }
  }
  @keyframes lb-ring-pulse {
    0%   { box-shadow: 0 8px 32px rgba(0,0,0,0.35), 0 0 0 0   transparent; }
    50%  { box-shadow: 0 8px 32px rgba(0,0,0,0.35), 0 0 0 16px var(--accent-dim); }
    100% { box-shadow: 0 8px 32px rgba(0,0,0,0.35), 0 0 0 0   transparent; }
  }

  /* Frequency visualizer ring — radiates outward from the FAB edge */
  .lb-viz-ring {
    position: absolute;
    top: -34px; left: -34px; right: -34px; bottom: -34px;
    pointer-events: none;
    z-index: 0;
    overflow: visible;
    color: var(--accent);
  }

  /* FAB robot wrapper */
  .fab-robot-wrap { display: flex; align-items: center; justify-content: center; position: relative; z-index: 1; }

  /* Unread badge */
  .lb-badge {
    position: absolute; top: 3px; right: 3px;
    width: 13px; height: 13px;
    border-radius: 50%;
    background: var(--danger);
    border: 2px solid var(--bg);
    animation: lb-badge-pulse 2s ease-in-out infinite;
  }
  @keyframes lb-badge-pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.2); } }

  @media (prefers-reduced-motion: reduce) {
    .lb-fab, .lb-arm, .lb-eye, .lb-badge { animation: none !important; transform: none !important; }
  }

  /* ═══ Backdrop ══════════════════════════════════════════════════════════ */
  .lb-backdrop {
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.5);
    backdrop-filter: blur(4px);
    z-index: 440;
  }
  @media (min-width: 769px) {
    .lb-backdrop { display: none; }
  }

  /* ═══ Panel ═════════════════════════════════════════════════════════════ */
  .lb-panel {
    position: fixed;
    bottom: 0; left: 0; right: 0;
    height: 88vh;
    background: var(--surface-1);
    border-top: 1px solid var(--border);
    border-radius: 20px 20px 0 0;
    z-index: 450;
    display: flex; flex-direction: column;
    box-shadow: 0 -8px 40px rgba(0,0,0,0.4);
    padding-bottom: var(--safe-bottom, 0px);
    overflow: hidden;
  }
  @media (min-width: 769px) {
    .lb-panel {
      position: fixed;
      right: 24px;
      bottom: calc(var(--nav-h, 0px) + var(--safe-bottom, 0px) + 96px);
      left: auto; top: auto;
      width: 420px;
      height: min(640px, 80vh);
      border: 1px solid var(--border);
      border-radius: 16px;
      box-shadow: 0 12px 48px rgba(0,0,0,0.45);
      padding-bottom: 0;
    }
  }

  .lb-drag-handle {
    width: 40px; height: 4px;
    border-radius: 2px;
    background: var(--text-3);
    opacity: 0.4;
    margin: 8px auto 4px;
  }
  @media (min-width: 769px) {
    .lb-drag-handle { display: none; }
  }

  /* ── Header ─────────────────────────────────────────────────────────── */
  .lb-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 14px 16px;
    background: linear-gradient(135deg, var(--accent-dim), transparent);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .lb-header-brand { display: flex; align-items: center; gap: 12px; }
  .lb-avatar {
    width: 40px; height: 40px; border-radius: 50%;
    background: var(--accent-dim);
    color: var(--accent);
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
  }
  .lb-header-name { font-size: 15px; font-weight: 700; color: var(--text-1); }
  .lb-header-sub  { font-size: 11px; color: var(--text-3); margin-top: 1px; }
  .lb-header-actions { display: flex; gap: 4px; }
  .lb-hdr-btn {
    width: 36px; height: 36px; border-radius: 50%;
    background: none; border: none; cursor: pointer;
    color: var(--text-3); display: flex; align-items: center; justify-content: center;
    transition: all var(--dur-fast);
  }
  .lb-hdr-btn:hover { color: var(--text-1); background: var(--surface-2); }

  /* ── Messages ───────────────────────────────────────────────────────── */
  .lb-messages {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
    display: flex; flex-direction: column; gap: 12px;
    overscroll-behavior: contain;
  }

  /* Welcome */
  .lb-welcome {
    display: flex; flex-direction: column; align-items: center;
    text-align: center; padding: 32px 24px;
    margin: auto 0;
  }
  .lb-welcome-avatar {
    width: 80px; height: 80px; border-radius: 50%;
    background: var(--accent-dim);
    color: var(--accent);
    display: flex; align-items: center; justify-content: center;
    margin-bottom: 8px;
  }
  .lb-welcome-name { font-size: 18px; font-weight: 700; color: var(--text-1); }
  .lb-welcome-desc {
    font-size: 13px; color: var(--text-2); line-height: 1.6;
    max-width: 280px; margin: 4px 0 16px;
  }
  .lb-chips { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; }
  .lb-chip {
    padding: 7px 14px; border-radius: var(--radius-full);
    border: 1px solid var(--border);
    background: var(--surface-2); color: var(--text-2);
    font-size: 12px; font-weight: 500;
    cursor: pointer; transition: all var(--dur-fast);
  }
  .lb-chip:hover { background: var(--accent-dim); color: var(--accent); border-color: var(--accent); }

  /* Messages */
  .lb-msg {
    display: flex; align-items: flex-end; gap: 8px;
    max-width: 100%;
  }
  .lb-msg.user {
    flex-direction: row-reverse;
  }
  .lb-msg-avatar {
    width: 32px; height: 32px; border-radius: 50%;
    background: var(--accent-dim);
    color: var(--accent);
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
  }
  .lb-msg-body {
    display: flex; flex-direction: column; gap: 3px;
    max-width: calc(100% - 40px);
  }
  .lb-msg.user .lb-msg-body { align-items: flex-end; }

  .lb-bubble {
    padding: 10px 14px;
    border-radius: 18px;
    font-size: 14px; line-height: 1.5;
    white-space: pre-wrap; word-break: break-word;
  }
  /* Assistant bubble */
  .lb-msg:not(.user) .lb-bubble {
    background: var(--surface-2); color: var(--text-1);
    border-bottom-left-radius: 6px;
  }
  /* User bubble */
  .lb-msg.user .lb-bubble {
    background: linear-gradient(135deg, var(--accent), var(--accent-2, var(--accent)));
    color: var(--accent-text, #fff);
    border-bottom-right-radius: 6px;
  }
  .lb-time {
    font-size: 10px; color: var(--text-3);
    padding: 0 4px;
  }

  /* "Use This Workout" — appears under any assistant reply whose text
     contains a PLAN: line. Tapping pipes the plan through the existing
     Smart Add modal so the user can review + edit before saving. */
  .lb-plan-apply {
    align-self: flex-start;
    display: inline-flex; align-items: center; gap: 6px;
    margin-top: 6px;
    padding: 7px 12px;
    border-radius: var(--radius-full);
    background: var(--accent-dim);
    border: 1px solid var(--accent);
    color: var(--accent);
    font-size: 12px; font-weight: 600;
    cursor: pointer; font-family: inherit;
    transition: all var(--dur-fast);
  }
  .lb-plan-apply:hover { background: var(--accent); color: var(--accent-text, #fff); }
  .lb-plan-apply .material-symbols-rounded { font-size: 16px; }

  .lb-msg-img {
    max-width: 200px; max-height: 150px;
    border-radius: var(--radius-lg);
    margin-bottom: 4px; object-fit: cover;
  }

  /* Typing dots */
  .lb-typing {
    display: flex; align-items: center; gap: 5px;
    padding: 12px 16px; min-width: 60px;
  }
  .lb-dot {
    width: 7px; height: 7px;
    border-radius: 50%;
    background: var(--text-3);
    animation: lb-bounce 1.4s ease-in-out infinite;
  }
  .lb-dot:nth-child(2) { animation-delay: 0.2s; }
  .lb-dot:nth-child(3) { animation-delay: 0.4s; }
  @keyframes lb-bounce {
    0%, 60%, 100% { transform: translateY(0);    opacity: 0.4; }
    30%            { transform: translateY(-6px); opacity: 1;   }
  }

  /* ── Image preview strip ────────────────────────────────────────────── */
  .lb-img-preview {
    display: flex; gap: 8px; padding: 8px 16px 0;
    flex-shrink: 0; overflow-x: auto;
  }
  .lb-preview-thumb {
    position: relative; flex-shrink: 0;
  }
  .lb-preview-thumb img {
    max-height: 120px; max-width: 100%;
    border-radius: var(--radius-lg);
    object-fit: cover;
  }
  .lb-img-remove {
    position: absolute; top: 4px; right: 4px;
    width: 22px; height: 22px;
    border-radius: 50%; background: rgba(0,0,0,0.6); color: #fff;
    border: none; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
  }

  /* ── Input bar ──────────────────────────────────────────────────────── */
  .lb-input-bar {
    display: flex; align-items: flex-end; gap: 8px;
    padding: 12px 16px;
    border-top: 1px solid var(--border);
    background: var(--surface-1);
    flex-shrink: 0;
  }
  .lb-textarea {
    flex: 1; resize: none;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 10px 14px;
    font-size: 14px; font-family: inherit;
    color: var(--text-1); line-height: 1.5;
    max-height: 120px; overflow-y: auto;
    outline: none;
    transition: border-color var(--dur-fast);
  }
  .lb-textarea:focus { border-color: var(--accent); }
  .lb-textarea::placeholder { color: var(--text-3); }

  .lb-send-btn {
    width: 40px; height: 40px;
    border-radius: 50%;
    background: linear-gradient(135deg, var(--accent), var(--accent-2, var(--accent)));
    color: var(--accent-text, #fff);
    border: none; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
    transition: transform var(--dur-fast), opacity var(--dur-fast);
  }
  .lb-send-btn:disabled { opacity: 0.4; cursor: default; }
  .lb-send-btn:not(:disabled):hover  { transform: scale(1.08); }
  .lb-send-btn:not(:disabled):active { transform: scale(0.94); }

  .lb-attach-wrap { position: relative; }
  .lb-attach-btn {
    width: 40px; height: 40px; border-radius: 50%;
    background: none; border: 1px solid var(--border);
    color: var(--text-3); cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    transition: all var(--dur-fast);
  }
  .lb-attach-btn:hover { color: var(--accent); border-color: var(--accent); }

  .lb-attach-menu {
    position: absolute; bottom: 48px; left: 0;
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: 0 4px 16px rgba(0,0,0,0.2);
    z-index: 10; min-width: 140px;
    overflow: hidden;
  }
  .lb-attach-option {
    display: flex; align-items: center; gap: 8px;
    width: 100%; padding: 10px 14px;
    background: none; border: none;
    color: var(--text-1); font-size: 14px;
    cursor: pointer; text-align: left;
  }
  .lb-attach-option:hover { background: var(--surface-2); }
  .lb-attach-option + .lb-attach-option { border-top: 1px solid var(--border); }
</style>
