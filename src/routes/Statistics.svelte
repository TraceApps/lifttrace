<script>
  import { onMount, onDestroy } from 'svelte';
  import { push } from 'svelte-spa-router';
  import { _ } from 'svelte-i18n';
  import { LtApi } from '../lib/api.js';
  import { weightUnit, pageBanners, bannerStyle } from '../stores/settings.js';
  import Spinner from '../components/ui/Spinner.svelte';
  import WeeklyVolumeChart from '../components/statistics/WeeklyVolumeChart.svelte';
  import WorkoutFrequencyChart from '../components/statistics/WorkoutFrequencyChart.svelte';
  import Sparkline from '../components/statistics/Sparkline.svelte';
  import MuscleRecovery from '../components/statistics/MuscleRecovery.svelte';
  import Sheet from '../components/ui/Sheet.svelte';
  import BodyMap from '../components/statistics/BodyMap.svelte';
  import { MUSCLES, MUSCLE_NAME, rankOf } from '../lib/muscles.js';
  import { weeklyWorkoutGoal, cardioEnabled, weeklyCardioMinutesGoal, caloriesBurnedEnabled, heightCm, currentWeightKg } from '../stores/settings.js';
  import { currentUser } from '../stores/auth.js';
  import { DB } from '../lib/db.js';
  import { estimateWorkoutCalories, ageFromDob } from '../lib/workout.js';
  import { fmtVol, fmtWeekLabel } from '../lib/statsFormat.js';
  import { localDateStr } from '../lib/db.js';
  import { showError } from '../stores/toast.js';

  // ── Metric + range state ─────────────────────────────────────────────
  // Base metric pills — cardio conditionally appended when the user
  // has opted-in via Settings → Workout → Track Cardio.
  const BASE_METRICS = [
    { id: 'overview', labelKey: 'statistics.tabs.overview', icon: 'dashboard' },
    { id: 'progress', labelKey: 'statistics.tabs.progress', icon: 'trending_up' },
    { id: 'records',  labelKey: 'statistics.tabs.records',  icon: 'emoji_events' },
    { id: 'volume',   labelKey: 'statistics.tabs.volume',   icon: 'fitness_center' },
    { id: 'freq',     labelKey: 'statistics.tabs.freq',     icon: 'calendar_month' },
    { id: 'weight',   labelKey: 'statistics.tabs.weight',   icon: 'monitor_weight' },
  ];
  const CARDIO_METRIC = { id: 'cardio', labelKey: 'statistics.tabs.cardio', icon: 'directions_run' };
  $: METRICS = $cardioEnabled ? [...BASE_METRICS, CARDIO_METRIC] : BASE_METRICS;

  const RANGES = { '1W': 7, '1M': 30, '3M': 90, '6M': 180, '1Y': 365, 'All': null };
  // Rendered chip labels, keyed off the same range identifiers used for logic
  // (RANGES[range] lookups, range === 'All' comparisons, etc). The RANGES
  // keys themselves stay untranslated identifiers; only what's shown changes.
  const RANGE_LABEL_KEYS = { '1W': 'statistics.ranges.w1', '1M': 'statistics.ranges.m1', '3M': 'statistics.ranges.m3', '6M': 'statistics.ranges.m6', '1Y': 'statistics.ranges.y1', 'All': 'statistics.ranges.all' };

  let metric = 'overview';
  let range = '1M';
  // For the 'All' range we resolve the earliest workout_log date from the
  // server and use that as the start. Avoids the previous 10-year ceiling
  // (which silently chopped older imported data). Loaded lazily.
  let earliestWorkoutDate = null;

  $: startDate = (() => {
    if (range === 'All') return earliestWorkoutDate || '2000-01-01';
    const d = new Date();
    d.setDate(d.getDate() - RANGES[range]);
    return localDateStr(d);
  })();
  $: endDate = localDateStr();

  // ── Shared data (loaded on mount, refreshed on range change) ─────────
  let streaks = { currentStreak: 0, longestStreak: 0, totalWorkouts: 0 };
  let volume = [];
  let frequency = [];
  let records = [];
  let muscleGroups = [];
  let muscleLoad = {};   // { [slug]: effectiveSets } for the body map
  let weekdayDist = [];
  let cardioWeekly = []; // [{ week, minutes }] for the Cardio metric
  let cardioSessions = []; // individual sessions in range, newest first, for the session list under the chart
  let workoutDates = new Set();
  let recentWorkouts = []; // full records (exercises + duration) — used by the calorie estimator
  let exercises = [];
  let loading = true;

  // ── Exercise-progress state ──────────────────────────────────────────
  let selectedExerciseId = null;
  let progressData = [];
  let progressLoading = false;

  // ── Body weight state ────────────────────────────────────────────────
  let bodyWeights = [];

  // ── Scroll restore per metric ────────────────────────────────────────
  // sessionStorage key per-metric so switching "Volume → Frequency → Volume"
  // lands back where you were in Volume.
  const SCROLL_KEY = 'stats-scroll';
  function _restoreScroll(m) {
    try {
      const raw = sessionStorage.getItem(SCROLL_KEY);
      const map = raw ? JSON.parse(raw) : {};
      const y = map[m];
      if (typeof y === 'number') {
        requestAnimationFrame(() => window.scrollTo({ top: y, behavior: 'instant' }));
      } else {
        requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: 'instant' }));
      }
    } catch {}
  }
  function _saveScroll(m) {
    try {
      const raw = sessionStorage.getItem(SCROLL_KEY);
      const map = raw ? JSON.parse(raw) : {};
      map[m] = window.scrollY;
      sessionStorage.setItem(SCROLL_KEY, JSON.stringify(map));
    } catch {}
  }
  function switchMetric(next) {
    if (next === metric) return;
    _saveScroll(metric);
    metric = next;
    _restoreScroll(next);
  }

  // ── Sliding pill indicator ───────────────────────────────────────────
  // Measures the active pill's DOM position so a single absolutely-
  // positioned indicator can slide between variably-sized, horizontally
  // scrolling pills. Updates on metric change + window resize.
  let metricBarEl;
  const pillRefs = new Array(7);
  // If the user disables cardio while sitting on the Cardio metric, snap
  // back to Overview so we don't render a metric whose pill is gone.
  $: if (!$cardioEnabled && metric === 'cardio') metric = 'overview';
  let indicatorPos = { left: 0, width: 0 };
  function _measureIndicator() {
    const activeIdx = METRICS.findIndex(m => m.id === metric);
    const el = pillRefs[activeIdx];
    if (!el) return;
    indicatorPos = { left: el.offsetLeft, width: el.offsetWidth };
  }
  $: metric, pillRefs, setTimeout(_measureIndicator, 0);
  if (typeof window !== 'undefined') window.addEventListener('resize', _measureIndicator);

  // Refresh stats whenever a background sync brings new workouts down
  // (native+server mode). Without this listener the page would only
  // re-fetch on next navigation, so freshly-pulled workouts wouldn't
  // show up in charts until the user left and came back.
  let _onSyncComplete = null;
  onMount(async () => {
    try { exercises = await LtApi.getExercises(); } catch {}
    try {
      const res = await fetch('/api/stats/earliest-workout-date', { credentials: 'include' });
      if (res.ok) { const d = await res.json(); earliestWorkoutDate = d?.date || null; }
    } catch {}
    await loadData();

    _onSyncComplete = () => { loadData(); };
    window.addEventListener('lt:sync-complete', _onSyncComplete);
  });

  onDestroy(() => {
    if (_onSyncComplete) window.removeEventListener('lt:sync-complete', _onSyncComplete);
  });

  $: range, loadData();

  async function loadData() {
    loading = true;
    try {
      const [v, f, r, s, mg, mes, wd, cw, cs] = await Promise.all([
        LtApi.getVolume(startDate, endDate),
        LtApi.getFrequency(startDate, endDate),
        LtApi.getRecords(),
        LtApi.getStreaks(),
        LtApi.getMuscleGroupVolume(startDate, endDate),
        LtApi.getMuscleEffectiveSets(startDate, endDate),
        LtApi.getWeekdayDistribution(startDate, endDate),
        LtApi.getCardioWeekly(startDate, endDate).catch(() => []),
        LtApi.listCardio(startDate, endDate).catch(() => []),
      ]);
      volume = v; frequency = f; records = r; streaks = s;
      muscleGroups = mg; muscleLoad = mes || {}; weekdayDist = wd;
      cardioWeekly = Array.isArray(cw) ? cw : [];
      cardioSessions = Array.isArray(cs) ? cs : [];

      // Heatmap dates + cached full records (the calorie estimator needs
      // exercises + duration_min, both already in this payload).
      try {
        const recent = await fetch('/api/workout/recent?limit=365', { credentials: 'include' });
        if (recent.ok) {
          const logs = await recent.json();
          workoutDates = new Set(logs.map(l => l.date));
          recentWorkouts = logs;
        }
      } catch {}

      // Body weight sampling
      await loadBodyWeights();

      // If exercise progress is selected, refresh its data too
      if (metric === 'progress' && selectedExerciseId) await loadProgress();
    } catch(e) {
      console.error(e);
      showError($_('statistics.load_failed'));
    }
    loading = false;
  }

  async function loadBodyWeights() {
    try {
      // Body stats are independent of workout history: someone can weigh in
      // during a break, or import years of weigh-ins from another app before
      // logging their first session here. Bounding "All" by the first workout
      // date silently hides those, so this range starts from the epoch floor
      // that startDate already falls back to when there are no workouts.
      const from = range === 'All' ? '2000-01-01' : startDate;
      const rows = await LtApi.getBodyStatsRange(from, endDate);
      bodyWeights = (rows || [])
        .map(r => ({ date: r.date, weight: parseFloat(r.stats?.weight) }))
        .filter(p => Number.isFinite(p.weight))
        .sort((a, b) => a.date.localeCompare(b.date));
    } catch { bodyWeights = []; }
  }

  async function loadProgress() {
    if (!selectedExerciseId) { progressData = []; return; }
    progressLoading = true;
    try {
      progressData = await LtApi.getProgress(selectedExerciseId, startDate, endDate);
    } catch(e) {
      showError(e.message);
      progressData = [];
    }
    progressLoading = false;
  }

  $: selectedExerciseId, range, metric === 'progress' && loadProgress();

  // ── Derived values ───────────────────────────────────────────────────
  $: totalVolume = volume.reduce((sum, v) => sum + v.volume, 0);
  $: totalWorkoutsInRange = frequency.reduce((sum, f) => sum + f.count, 0);

  // Estimated calories burned across the current range. Returns null when
  // the user hasn't opted in OR the body profile is incomplete — the UI
  // hides the row in that case rather than showing "0 kcal" (which would
  // imply the workout had no thermic effect).
  $: rangeCalories = (() => {
    if (!$caloriesBurnedEnabled || !recentWorkouts.length) return null;
    const dob = $currentUser?.birthday || DB.getSetting('dob', null);
    const sex = $currentUser?.gender   || DB.getSetting('gender', null);
    const profile = {
      weight_kg: $currentWeightKg,
      height_cm: $heightCm,
      age: ageFromDob(dob),
      sex,
    };
    if (!profile.weight_kg || !profile.height_cm || !profile.age) return null;
    const inRange = recentWorkouts.filter(w => w.date >= startDate && w.date <= endDate);
    let total = 0;
    for (const w of inRange) {
      const k = estimateWorkoutCalories(w, profile);
      if (k != null) total += k;
    }
    return Math.round(total);
  })();
  $: avgFreq = frequency.length ? (totalWorkoutsInRange / frequency.length).toFixed(1) : 0;

  // Weekly goal progress for the Overview ring. Uses the current ISO-style
  // week (Mon-first like every other week-anchored stat here) so the ring
  // fills as the user trains through the week and resets each Monday.
  $: weekProgress = (() => {
    const goal = $weeklyWorkoutGoal || 4;
    const today = new Date();
    const dow = (today.getDay() + 6) % 7;  // Mon=0..Sun=6
    const start = new Date(today); start.setDate(today.getDate() - dow);
    const startStr = localDateStr(start);
    const todayStr = localDateStr();
    const count = recentWorkouts.filter(w =>
      w.completed && w.date >= startStr && w.date <= todayStr
    ).length;
    const pct = Math.min(100, Math.round((count / goal) * 100));
    return { count, goal, pct };
  })();

  // Period-over-period deltas. Compares the current range's volume +
  // workout count to the same-length window immediately before. Returns
  // null when the user has nothing in the prior window to compare.
  $: periodDeltas = (() => {
    if (!recentWorkouts.length || !volume.length) return null;
    const rangeDays = RANGES[range];
    if (!rangeDays) return null;  // 'All' has no prior period
    const priorEnd = new Date(startDate + 'T12:00:00');
    priorEnd.setDate(priorEnd.getDate() - 1);
    const priorStart = new Date(priorEnd);
    priorStart.setDate(priorStart.getDate() - rangeDays + 1);
    const priorEndStr = localDateStr(priorEnd);
    const priorStartStr = localDateStr(priorStart);
    const priorWorkouts = recentWorkouts.filter(w =>
      w.completed && w.date >= priorStartStr && w.date <= priorEndStr
    );
    if (priorWorkouts.length === 0) return null;
    let priorVol = 0;
    for (const w of priorWorkouts) {
      const exs = (typeof w.exercises === 'string' ? JSON.parse(w.exercises || '[]') : (w.exercises || []));
      for (const ex of exs) {
        const lt = ex.load_type || 'bilateral';
        for (const s of (ex.sets || [])) {
          if (!s.completed || s.warmup) continue;
          const wt = s.weight || 0;
          if (lt === 'unilateral') {
            if (s.reps_l != null || s.reps_r != null) priorVol += wt * ((s.reps_l || 0) + (s.reps_r || 0));
            else priorVol += wt * (s.reps || 0) * 2;
          } else if (lt === 'paired') {
            priorVol += wt * (s.reps || 0) * 2;
          } else {
            priorVol += wt * (s.reps || 0);
          }
        }
      }
    }
    const volPct = priorVol ? Math.round(((totalVolume - priorVol) / priorVol) * 100) : null;
    const cntPct = priorWorkouts.length
      ? Math.round(((totalWorkoutsInRange - priorWorkouts.length) / priorWorkouts.length) * 100)
      : null;
    return { volPct, cntPct, priorVol, priorCount: priorWorkouts.length };
  })();
  $: maxVolWeek = volume.length ? Math.max(...volume.map(v => v.volume)) : 0;
  $: maxFreqWeek = frequency.length ? Math.max(...frequency.map(f => f.count)) : 0;
  $: maxWeekdayCount = weekdayDist.length ? Math.max(...weekdayDist.map(w => w.count)) : 0;

  // Heatmap (90 days, Mon-first week)
  $: heatmapDays = Array.from({ length: 91 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (90 - i));
    return localDateStr(d);
  });

  // Sparkline inputs — computed once per data load.
  // 14-day dot sparkline for the streak card: 1 per day, filled when a
  // workout was logged.
  $: streakSparkline = Array.from({ length: 14 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (13 - i));
    return workoutDates.has(localDateStr(d)) ? 1 : 0;
  });
  // Last-8-weeks bar sparkline for the "This {range}" card. Uses the
  // already-loaded frequency array (one row per week).
  $: freqSparkline = (frequency || []).slice(-8).map(f => f.count || 0);

  // ── Progress-metric derived ──────────────────────────────────────────
  $: selectedExercise = exercises.find(e => e.id === selectedExerciseId);
  $: progressStats = (() => {
    if (!progressData.length) return null;
    const weights = progressData.map(p => p.maxWeight);
    return {
      min:  Math.min(...weights),
      max:  Math.max(...weights),
      avg:  Math.round(weights.reduce((a, b) => a + b, 0) / weights.length),
      sessions: progressData.length,
      first: progressData[0],
      last:  progressData[progressData.length - 1],
    };
  })();

  // ── Records — group by category ──────────────────────────────────────
  const CATEGORY_ORDER = ['chest','back','shoulders','arms','legs','core','cardio','other'];
  const CATEGORY_LABELS = {
    chest: 'statistics.categories.chest', back: 'statistics.categories.back', shoulders: 'statistics.categories.shoulders', arms: 'statistics.categories.arms',
    legs: 'statistics.categories.legs', core: 'statistics.categories.core', cardio: 'statistics.categories.cardio', other: 'statistics.categories.other',
  };

  $: groupedRecords = (() => {
    const byCat = {};
    for (const r of records) {
      // Find the exercise's category (needs the exercises list)
      const ex = exercises.find(e => e.id === r.exerciseId || e.name === r.name);
      const cat = (ex?.category || 'other').toLowerCase();
      const key = CATEGORY_ORDER.includes(cat) ? cat : 'other';
      if (!byCat[key]) byCat[key] = [];
      byCat[key].push(r);
    }
    // Sort each group by max weight desc, then return in canonical order
    for (const k in byCat) byCat[k].sort((a, b) => b.maxWeight - a.maxWeight);
    return CATEGORY_ORDER
      .filter(c => byCat[c] && byCat[c].length)
      .map(c => ({ category: c, labelKey: CATEGORY_LABELS[c], records: byCat[c] }));
  })();

  $: recentPRs = records
    .filter(r => r.date)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 5);

  // ── Utilities ────────────────────────────────────────────────────────
  // fmtVol + fmtWeekLabel now live in lib/statsFormat.js (shared with the
  // extracted chart components). Leave this note so nobody reintroduces
  // local copies.
  const DAY_LABELS = ['statistics.days.sun','statistics.days.mon','statistics.days.tue','statistics.days.wed','statistics.days.thu','statistics.days.fri','statistics.days.sat'];

  // Exercise picker state
  let showExPicker = false;
  let exSearch = '';
  $: filteredExs = exSearch
    ? exercises.filter(e => e.name.toLowerCase().includes(exSearch.toLowerCase())).slice(0, 50)
    : exercises.slice(0, 50);

  // ── Chart helpers (Svelte @const has template-scope restrictions) ────
  function _progressPoints(data) {
    if (!data.length) return [];
    const weights = data.map(p => p.maxWeight);
    const min = Math.min(...weights) - 5;
    const max = Math.max(...weights) + 5;
    const rng = Math.max(1, max - min);
    return data.map((p, i) => `${i * 20 + 10},${110 - ((p.maxWeight - min) / rng * 90 + 10)}`);
  }
  function _progressPointObjs(data) {
    if (!data.length) return [];
    const weights = data.map(p => p.maxWeight);
    const min = Math.min(...weights) - 5;
    const max = Math.max(...weights) + 5;
    const rng = Math.max(1, max - min);
    return data.map((p, i) => ({ x: i * 20 + 10, y: 110 - ((p.maxWeight - min) / rng * 90 + 10) }));
  }
  // RPE overlay — points with avgRpe only, mapped to a fixed 5-10 domain
  // (anything below RPE 5 is irrelevant for this chart). Returns objects
  // with { x, y, v } so we can render both a polyline and labeled points.
  function _rpePoints(data) {
    const pts = [];
    for (let i = 0; i < data.length; i++) {
      const v = data[i]?.avgRpe;
      if (v == null || !Number.isFinite(v)) continue;
      const y = 110 - ((Math.max(5, Math.min(10, v)) - 5) / 5 * 90 + 10);
      pts.push({ x: i * 20 + 10, y, v });
    }
    return pts;
  }
  $: rpePointObjs = _rpePoints(progressData);
  $: hasRpe = rpePointObjs.length >= 2;

  $: bwStats = (() => {
    if (!bodyWeights.length) return { current: 0, min: 0, max: 0, change: 0 };
    const weights = bodyWeights.map(b => b.weight);
    return {
      current: bodyWeights[bodyWeights.length - 1].weight,
      min: Math.min(...weights),
      max: Math.max(...weights),
      change: bodyWeights[bodyWeights.length - 1].weight - bodyWeights[0].weight,
    };
  })();

  function _bwPoints(data) {
    if (!data.length) return [];
    const weights = data.map(b => b.weight);
    const min = Math.min(...weights);
    const max = Math.max(...weights);
    const rng = Math.max(1, max - min + 4);
    return data.map((b, i) => `${i * 20 + 10},${110 - ((b.weight - min + 2) / rng * 90 + 10)}`);
  }
  function _bwPointObjs(data) {
    if (!data.length) return [];
    const weights = data.map(b => b.weight);
    const min = Math.min(...weights);
    const max = Math.max(...weights);
    const rng = Math.max(1, max - min + 4);
    return data.map((b, i) => ({ x: i * 20 + 10, y: 110 - ((b.weight - min + 2) / rng * 90 + 10) }));
  }
</script>

<div class="page">
  <header class="page-header" class:banner-gradient={$bannerStyle === 'gradient'} class:banner-animated={$bannerStyle === 'animated'}>
    <h1>{$_('routes.statistics.title')}</h1>
  </header>

  <!-- Metric pill selector with sliding indicator -->
  <div class="metric-bar" bind:this={metricBarEl}>
    <span class="metric-indicator" style:transform="translateX({indicatorPos.left}px)" style:width="{indicatorPos.width}px"></span>
    {#each METRICS as m, i}
      <button class="metric-pill" class:active={metric === m.id} on:click={() => switchMetric(m.id)} bind:this={pillRefs[i]}>
        <span class="material-symbols-rounded metric-icon">{m.icon}</span>
        <span class="metric-label">{$_(m.labelKey)}</span>
      </button>
    {/each}
  </div>

  <!-- Range picker -->
  <div class="range-bar">
    {#each Object.keys(RANGES) as r}
      <button class="range-chip" class:active={range === r} on:click={() => range = r}>{$_(RANGE_LABEL_KEYS[r])}</button>
    {/each}
  </div>

  <!-- Body wrapper — at >=1280px non-forced-mobile becomes a 2-col
       grid holding the per-metric widgets on the left and a sticky
       right rail (range picker + prior-period delta KPIs) on the
       right. On mobile / narrow this is a plain block so nothing
       changes below phone widths. -->
  <div class="stats-body">
  {#if loading}
    <div class="loading">{$_('statistics.loading_stats')}</div>
  {:else}
    <div class="content">
      <!-- ═════════ OVERVIEW ═════════ -->
      {#if metric === 'overview'}
        <!-- Overview body wrapper — at wide widths becomes a 2-col
             CSS grid so widgets share rows instead of vertically
             stacking. Goal ring / summary row / cal strip / empty
             span both columns; heatmap + MuscleRecovery share row 2;
             WeeklyVolume + WorkoutFrequency share row 3. -->
        <div class="overview-body">
        <!-- Weekly goal progress ring — the single most motivating widget
             on a fitness dashboard. Filled arc reflects this week's
             completed workouts vs the user's weekly target. -->
        {#if weekProgress.goal > 0}
          {@const ringCirc = 2 * Math.PI * 32}
          {@const ringOffset = ringCirc * (1 - weekProgress.pct / 100)}
          <div class="goal-ring-card" class:hit={weekProgress.pct >= 100}>
            <svg class="goal-ring" viewBox="0 0 80 80" aria-hidden="true">
              <circle class="goal-ring-bg" cx="40" cy="40" r="32" />
              <circle class="goal-ring-fg" cx="40" cy="40" r="32"
                stroke-dasharray={ringCirc}
                stroke-dashoffset={ringOffset} />
            </svg>
            <div class="goal-ring-body">
              <div class="goal-ring-top">
                <span class="goal-ring-num">{weekProgress.count}</span>
                <span class="goal-ring-of">{$_('statistics.of')}</span>
                <span class="goal-ring-num">{weekProgress.goal}</span>
                <span class="goal-ring-of">{$_('statistics.this_week')}</span>
              </div>
              <span class="goal-ring-pct">
                {#if weekProgress.pct >= 100}
                  🎯 {$_('statistics.goal_hit')}
                {:else}
                  {$_('statistics.to_go', { values: { n: weekProgress.goal - weekProgress.count } })}
                {/if}
              </span>
            </div>
          </div>
        {/if}

        <div class="summary-row">
          <div class="summary-card">
            <span class="material-symbols-rounded sc-icon">local_fire_department</span>
            <span class="sc-value">{streaks.currentStreak}</span>
            <span class="sc-label">{$_('statistics.day_streak')}</span>
            <div class="sc-spark" title={$_('statistics.streak_hint')}>
              <Sparkline type="dots" values={streakSparkline} width={84} height={14} color="var(--accent)" />
            </div>
          </div>
          <div class="summary-card">
            <span class="material-symbols-rounded sc-icon">emoji_events</span>
            <span class="sc-value">{streaks.longestStreak}</span>
            <span class="sc-label">{$_('statistics.longest')}</span>
          </div>
          <div class="summary-card">
            <span class="material-symbols-rounded sc-icon">calendar_today</span>
            <span class="sc-value">{totalWorkoutsInRange}</span>
            <span class="sc-label">{$_('statistics.this_range', { values: { range } })}</span>
            {#if periodDeltas && periodDeltas.cntPct != null}
              <span class="sc-delta" class:up={periodDeltas.cntPct > 0} class:down={periodDeltas.cntPct < 0}>
                {$_('statistics.vs_prior', { values: { pct: (periodDeltas.cntPct > 0 ? '+' : '') + periodDeltas.cntPct } })}
              </span>
            {:else if freqSparkline.length >= 2}
              <div class="sc-spark" title={$_('statistics.wpw_hint')}>
                <Sparkline type="bars" values={freqSparkline} width={84} height={14} color="var(--accent)" />
              </div>
            {/if}
          </div>
          <div class="summary-card">
            <span class="material-symbols-rounded sc-icon">speed</span>
            <span class="sc-value">{avgFreq}</span>
            <span class="sc-label">{$_('statistics.avg_week')}</span>
          </div>
        </div>

        {#if rangeCalories != null}
          <div class="cal-strip" title={$_('statistics.cal_hint')}>
            <span class="material-symbols-rounded cal-icon">local_fire_department</span>
            <span class="cal-val">{$_('statistics.kcal_amount', { values: { n: rangeCalories.toLocaleString() } })}</span>
            <span class="cal-label">{$_('statistics.burned_this', { values: { range } })}</span>
            <span class="cal-badge">{$_('statistics.est')}</span>
          </div>
        {/if}

        <div class="chart-card">
          <h3 class="chart-title">{$_('statistics.activity_90d')}</h3>
          <div class="heatmap">
            {#each heatmapDays as day}
              <div class="hm-cell"
                class:hm-active={workoutDates.has(day)}
                class:hm-today={day === localDateStr()}
                title={day + (workoutDates.has(day) ? ' ✓' : '')}></div>
            {/each}
          </div>
          <div class="hm-legend">
            <div class="hm-legend-scale">
              <div class="hm-cell"></div><span>{$_('statistics.hm_rest')}</span>
              <div class="hm-cell hm-active"></div><span>{$_('statistics.hm_workout')}</span>
            </div>
            <span class="hm-legend-label">{$_('statistics.total_workouts', { values: { n: streaks.totalWorkouts } })}</span>
          </div>
        </div>

        <MuscleRecovery workouts={recentWorkouts} {exercises} windowDays={7} />

        <WeeklyVolumeChart {volume} unit={$weightUnit} detailed total={totalVolume} />
        <WorkoutFrequencyChart {frequency} detailed avg={avgFreq} goal={$weeklyWorkoutGoal} />

        {#if totalWorkoutsInRange === 0}
          <div class="empty-state">
            <span class="material-symbols-rounded">fitness_center</span>
            <p>{$_('statistics.no_workouts_yet')}</p>
          </div>
        {/if}
        </div><!-- /.overview-body -->
      {/if}

      <!-- ═════════ EXERCISE PROGRESS ═════════ -->
      {#if metric === 'progress'}
        <button class="ex-picker-btn" on:click={() => { showExPicker = true; exSearch = ''; }}>
          <span class="material-symbols-rounded">search</span>
          <span>{selectedExercise?.name || $_('statistics.choose_exercise_fallback')}</span>
          <span class="material-symbols-rounded" style="margin-left:auto">chevron_right</span>
        </button>

        {#if !selectedExerciseId}
          <div class="empty-state">
            <span class="material-symbols-rounded">trending_up</span>
            <h4 class="empty-title">{$_('statistics.track_progress_title')}</h4>
            <p>{$_('statistics.track_progress_desc')}</p>
          </div>
        {:else if progressLoading}
          <Spinner block label={$_('statistics.loading_chart')} />
        {:else if !progressData.length}
          <div class="empty-state">
            <span class="material-symbols-rounded">info</span>
            <p>{@html $_('statistics.no_sets', { values: { name: `<strong>${selectedExercise?.name}</strong>` } })}</p>
          </div>
        {:else}
          <div class="summary-row">
            <div class="summary-card">
              <span class="sc-value-sm">{progressStats.max}</span>
              <span class="sc-label">{$_('statistics.max')} <span class="unit">{$weightUnit}</span></span>
            </div>
            <div class="summary-card">
              <span class="sc-value-sm">{progressStats.min}</span>
              <span class="sc-label">{$_('statistics.min')} <span class="unit">{$weightUnit}</span></span>
            </div>
            <div class="summary-card">
              <span class="sc-value-sm">{progressStats.avg}</span>
              <span class="sc-label">{$_('statistics.avg')} <span class="unit">{$weightUnit}</span></span>
            </div>
            <div class="summary-card">
              <span class="sc-value-sm">{progressStats.sessions}</span>
              <span class="sc-label">{$_('statistics.sessions')}</span>
            </div>
          </div>

          <div class="chart-card">
            <div class="chart-title-row">
              <h3 class="chart-title">{$_('statistics.top_set')}</h3>
              {#if hasRpe}
                <div class="chart-legend">
                  <span class="legend-item"><span class="legend-swatch accent"></span>{$_('statistics.top_set_legend', { values: { unit: $weightUnit } })}</span>
                  <span class="legend-item"><span class="legend-swatch rpe"></span>{$_('statistics.avg_rpe_legend')}</span>
                </div>
              {/if}
            </div>
            <svg class="line-chart" viewBox="0 0 {Math.max(progressData.length * 20, 200)} 120" preserveAspectRatio="none">
              <polyline fill="none" stroke="var(--accent)" stroke-width="2"
                stroke-linecap="round" stroke-linejoin="round"
                points={_progressPoints(progressData).join(' ')} />
              {#each _progressPointObjs(progressData) as pt}
                <circle cx={pt.x} cy={pt.y} r="3" fill="var(--accent)" />
              {/each}
              {#if hasRpe}
                <polyline fill="none" stroke="var(--warning, #FFB020)" stroke-width="1.5"
                  stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="4 3"
                  points={rpePointObjs.map(p => `${p.x},${p.y}`).join(' ')} />
                {#each rpePointObjs as pt}
                  <circle cx={pt.x} cy={pt.y} r="2.5" fill="var(--warning, #FFB020)" />
                {/each}
              {/if}
            </svg>
            <div class="chart-footer">
              <span>{progressStats.first?.date} · {progressStats.first?.maxWeight} {$weightUnit}</span>
              <span>{progressStats.last?.date} · {progressStats.last?.maxWeight} {$weightUnit}</span>
            </div>
          </div>

          <div class="list-card">
            <h3 class="chart-title">{$_('statistics.session_history')}</h3>
            {#each progressData.slice().reverse() as p}
              <div class="history-row">
                <span class="hr-date">{p.date}</span>
                <span class="hr-value">{p.maxWeight} {$weightUnit} · {$_('statistics.n_sets', { values: { n: p.sets } })}</span>
              </div>
            {/each}
          </div>
        {/if}
      {/if}

      <!-- ═════════ RECORDS ═════════ -->
      {#if metric === 'records'}
        {#if !records.length}
          <div class="empty-state">
            <span class="material-symbols-rounded">emoji_events</span>
            <p>{$_('statistics.no_records_yet')}</p>
          </div>
        {:else}
          {#if recentPRs.length}
            <div class="section">
              <h3 class="section-title">
                <span class="material-symbols-rounded">trending_up</span>
                {$_('statistics.recent_prs')}
              </h3>
              <div class="records-list">
                {#each recentPRs as r}
                  {#if /^\d+$/.test(String(r.exerciseId))}
                    <button class="record-row linked" on:click={() => push(`/exercise/${r.exerciseId}`)} title={$_('statistics.open_exercise')}>
                      <span class="record-name">{r.name}</span>
                      <div class="record-data">
                        <span class="record-weight">{r.maxWeight} {$weightUnit} × {r.maxReps}</span>
                        <span class="record-meta">{r.date}</span>
                      </div>
                      <span class="material-symbols-rounded record-chev">chevron_right</span>
                    </button>
                  {:else}
                    <div class="record-row">
                      <span class="record-name">{r.name}</span>
                      <div class="record-data">
                        <span class="record-weight">{r.maxWeight} {$weightUnit} × {r.maxReps}</span>
                        <span class="record-meta">{r.date}</span>
                      </div>
                    </div>
                  {/if}
                {/each}
              </div>
            </div>
          {/if}

          {#each groupedRecords as group}
            <div class="section">
              <h3 class="section-title">{$_(group.labelKey)}</h3>
              <div class="records-list">
                {#each group.records as r}
                  {#if /^\d+$/.test(String(r.exerciseId))}
                    <button class="record-row linked" on:click={() => push(`/exercise/${r.exerciseId}`)} title={$_('statistics.open_exercise')}>
                      <span class="record-name">{r.name}</span>
                      <div class="record-data">
                        <span class="record-weight">{r.maxWeight} {$weightUnit} × {r.maxReps}</span>
                        <span class="record-meta">
                          {r.date}
                          {#if r.e1rm > r.maxWeight}{$_('statistics.est_1rm', { values: { v: r.e1rm } })}{/if}
                        </span>
                      </div>
                      <span class="material-symbols-rounded record-chev">chevron_right</span>
                    </button>
                  {:else}
                    <div class="record-row">
                      <span class="record-name">{r.name}</span>
                      <div class="record-data">
                        <span class="record-weight">{r.maxWeight} {$weightUnit} × {r.maxReps}</span>
                        <span class="record-meta">
                          {r.date}
                          {#if r.e1rm > r.maxWeight}{$_('statistics.est_1rm', { values: { v: r.e1rm } })}{/if}
                        </span>
                      </div>
                    </div>
                  {/if}
                {/each}
              </div>
            </div>
          {/each}
        {/if}
      {/if}

      <!-- ═════════ VOLUME ═════════ -->
      {#if metric === 'volume'}
        <div class="summary-row">
          <div class="summary-card">
            <span class="sc-value-sm">{fmtVol(totalVolume)}</span>
            <span class="sc-label">{$_('statistics.total')} <span class="unit">{$weightUnit}</span></span>
          </div>
          <div class="summary-card">
            <span class="sc-value-sm">{fmtVol(maxVolWeek)}</span>
            <span class="sc-label">{$_('statistics.peak_week')}</span>
          </div>
          <div class="summary-card">
            <span class="sc-value-sm">{volume.length ? fmtVol(totalVolume / volume.length) : 0}</span>
            <span class="sc-label">{$_('statistics.avg_week')}</span>
          </div>
          <div class="summary-card">
            <span class="sc-value-sm">{volume.length}</span>
            <span class="sc-label">{$_('statistics.weeks')}</span>
          </div>
        </div>

        <WeeklyVolumeChart {volume} unit={$weightUnit} />

        {#if muscleLoad && Object.keys(muscleLoad).length > 0}
          {@const rank = rankOf(muscleLoad)}
          {@const totalSets = MUSCLES.reduce((s, m) => s + (muscleLoad[m] || 0), 0)}
          <div class="chart-card muscle-balance-card">
            <h3 class="chart-title">{$_('statistics.muscle_balance')}</h3>
            <p class="chart-sub mb-desc">
              {$_('statistics.muscle_balance_desc')}
            </p>
            <!-- Body-map + detail split into 2 cols at wide widths so
                 the BodyMap becomes a proper hero on the left and the
                 legend / not-trained chips / effective-set line stack
                 in a scannable column on the right. -->
            <div class="mb-body-col">
              <BodyMap load={muscleLoad} />
            </div>
            <div class="mb-detail-col">
              <!-- Shade legend, five steps matching the .bm-m.l0…l4 scale.
                   Same vocabulary the muscle-heat coloring uses so "more
                   accent = more training" reads the same everywhere. -->
              <div class="bm-legend">
                <span class="bm-legend-label">{$_('statistics.less')}</span>
                <span class="bm-legend-swatch l0"></span>
                <span class="bm-legend-swatch l1"></span>
                <span class="bm-legend-swatch l2"></span>
                <span class="bm-legend-swatch l3"></span>
                <span class="bm-legend-swatch l4"></span>
                <span class="bm-legend-label">{$_('statistics.more')}</span>
              </div>

              {#if rank.missed.length > 0}
                <div class="bm-missed">
                  <p class="bm-missed-title">{$_('statistics.not_trained')}</p>
                  <div class="bm-chips">
                    {#each rank.missed as slug}
                      <span class="bm-chip">{MUSCLE_NAME[slug]}</span>
                    {/each}
                  </div>
                </div>
              {/if}

              <p class="chart-sub mb-effective">
                {rank.worked.length === 1
                  ? $_('statistics.effective_sets_one', { values: { n: totalSets.toFixed(1), m: rank.worked.length } })
                  : $_('statistics.effective_sets_other', { values: { n: totalSets.toFixed(1), m: rank.worked.length } })}
              </p>
            </div>
          </div>
        {/if}

        {#if volume.length === 0}
          <div class="empty-state">
            <span class="material-symbols-rounded">fitness_center</span>
            <p>{$_('statistics.no_volume_range')}</p>
          </div>
        {/if}
      {/if}

      <!-- ═════════ FREQUENCY ═════════ -->
      {#if metric === 'freq'}
        <div class="summary-row">
          <div class="summary-card">
            <span class="sc-value-sm">{totalWorkoutsInRange}</span>
            <span class="sc-label">{$_('statistics.workouts')}</span>
          </div>
          <div class="summary-card">
            <span class="sc-value-sm">{avgFreq}</span>
            <span class="sc-label">{$_('statistics.avg_week')}</span>
          </div>
          <div class="summary-card">
            <span class="sc-value-sm">{maxFreqWeek}</span>
            <span class="sc-label">{$_('statistics.best_week')}</span>
          </div>
          <div class="summary-card">
            <span class="sc-value-sm">{streaks.currentStreak}</span>
            <span class="sc-label">{$_('statistics.streak')}</span>
          </div>
        </div>

        <WorkoutFrequencyChart {frequency} goal={$weeklyWorkoutGoal} />

        {#if weekdayDist.length > 0 && totalWorkoutsInRange > 0}
          <div class="chart-card">
            <h3 class="chart-title">{$_('statistics.weekday_dist')}</h3>
            <div class="bar-chart">
              {#each weekdayDist as w}
                <div class="bar-col">
                  <div class="bar" style="height: {maxWeekdayCount ? (w.count / maxWeekdayCount * 100) : 0}%"></div>
                  <span class="bar-label">{$_(DAY_LABELS[w.day])}</span>
                </div>
              {/each}
            </div>
            <p class="chart-sub">
              {$_('statistics.most_active', { values: { day: weekdayDist.length ? $_(DAY_LABELS[weekdayDist.indexOf(weekdayDist.reduce((a, b) => a.count > b.count ? a : b))]) : '—' } })}
            </p>
          </div>
        {/if}

        {#if totalWorkoutsInRange === 0}
          <div class="empty-state">
            <span class="material-symbols-rounded">calendar_month</span>
            <p>{$_('statistics.no_workouts_in_range')}</p>
          </div>
        {/if}
      {/if}

      <!-- ═════════ BODY WEIGHT ═════════ -->
      {#if metric === 'weight'}
        {#if bodyWeights.length === 0}
          <div class="empty-state">
            <span class="material-symbols-rounded">monitor_weight</span>
            <p>{$_('statistics.no_body_weight')}</p>
          </div>
        {:else}
          <div class="summary-row">
            <div class="summary-card">
              <span class="sc-value-sm">{bwStats.current}</span>
              <span class="sc-label">{$_('statistics.current')} <span class="unit">{$weightUnit}</span></span>
            </div>
            <div class="summary-card">
              <span class="sc-value-sm">{bwStats.min}</span>
              <span class="sc-label">{$_('statistics.min')}</span>
            </div>
            <div class="summary-card">
              <span class="sc-value-sm">{bwStats.max}</span>
              <span class="sc-label">{$_('statistics.max')}</span>
            </div>
            <div class="summary-card">
              <span class="sc-value-sm" class:gain={bwStats.change > 0} class:loss={bwStats.change < 0}>
                {bwStats.change > 0 ? '+' : ''}{bwStats.change.toFixed(1)}
              </span>
              <span class="sc-label">{$_('statistics.change')}</span>
            </div>
          </div>

          <div class="chart-card">
            <h3 class="chart-title">{$_('statistics.body_weight_trend')}</h3>
            <svg class="line-chart" viewBox="0 0 {Math.max(bodyWeights.length * 20, 200)} 120" preserveAspectRatio="none">
              <polyline fill="none" stroke="var(--accent)" stroke-width="2"
                stroke-linecap="round" stroke-linejoin="round"
                points={_bwPoints(bodyWeights).join(' ')} />
              {#each _bwPointObjs(bodyWeights) as pt}
                <circle cx={pt.x} cy={pt.y} r="3" fill="var(--accent)" />
              {/each}
            </svg>
            <div class="chart-footer">
              <span>{bodyWeights[0]?.date}</span>
              <span>{bodyWeights[bodyWeights.length - 1]?.date}</span>
            </div>
          </div>

          <div class="list-card">
            <h3 class="chart-title">{$_('statistics.history')}</h3>
            {#each bodyWeights.slice().reverse() as b}
              <div class="history-row">
                <span class="hr-date">{b.date}</span>
                <span class="hr-value">{b.weight} {$weightUnit}</span>
              </div>
            {/each}
          </div>
        {/if}
      {/if}

      {#if metric === 'cardio'}
        {@const cwTotal = cardioWeekly.reduce((s, w) => s + (w.minutes || 0), 0)}
        {@const cwMax   = cardioWeekly.reduce((s, w) => Math.max(s, w.minutes || 0), 0)}
        {@const cwAvg   = cardioWeekly.length ? Math.round(cwTotal / cardioWeekly.length) : 0}
        {@const cwHit   = $weeklyCardioMinutesGoal > 0 ? cardioWeekly.filter(w => w.minutes >= $weeklyCardioMinutesGoal).length : 0}
        {#if cardioWeekly.length === 0}
          <div class="empty-state">
            <span class="material-symbols-rounded">directions_run</span>
            <p>{$_('statistics.no_cardio_range')}</p>
          </div>
        {:else}
          <div class="summary-row">
            <div class="summary-card">
              <span class="sc-value-sm">{cwTotal}</span>
              <span class="sc-label">{$_('statistics.total')} <span class="unit">min</span></span>
            </div>
            <div class="summary-card">
              <span class="sc-value-sm">{cwAvg}</span>
              <span class="sc-label">{$_('statistics.avg_week')}</span>
            </div>
            <div class="summary-card">
              <span class="sc-value-sm">{cwMax}</span>
              <span class="sc-label">{$_('statistics.peak_week')}</span>
            </div>
            {#if $weeklyCardioMinutesGoal > 0}
              <div class="summary-card">
                <span class="sc-value-sm">{cwHit}<span class="sc-sub">/{cardioWeekly.length}</span></span>
                <span class="sc-label">{$_('statistics.on_target')}</span>
              </div>
            {/if}
          </div>

          <div class="chart-card">
            <h3 class="chart-title">{$_('statistics.weekly_minutes')}</h3>
            <div class="cw-bars" style="--target-frac: {$weeklyCardioMinutesGoal > 0 && cwMax > 0 ? Math.min(1, $weeklyCardioMinutesGoal / Math.max(cwMax, $weeklyCardioMinutesGoal)) : 0}">
              {#each cardioWeekly as w}
                {@const denom = Math.max(cwMax, $weeklyCardioMinutesGoal || 0)}
                {@const pct = denom > 0 ? Math.round((w.minutes / denom) * 100) : 0}
                {@const hitGoal = $weeklyCardioMinutesGoal > 0 && w.minutes >= $weeklyCardioMinutesGoal}
                <div class="cw-col" title={$_('statistics.week_minutes', { values: { week: w.week, n: w.minutes } })}>
                  <div class="cw-fill" class:hit={hitGoal} style="height:{pct}%"></div>
                  <span class="cw-label">{w.week.slice(5)}</span>
                </div>
              {/each}
            </div>
            {#if $weeklyCardioMinutesGoal > 0}
              <p class="chart-sub" style="text-align:center">{$_('statistics.target_min_week', { values: { n: $weeklyCardioMinutesGoal } })}</p>
            {:else}
              <p class="chart-sub" style="text-align:center">{$_('statistics.no_target_hint')}</p>
            {/if}
          </div>

          {#if cardioSessions.length > 0}
            <div class="chart-card">
              <h3 class="chart-title">{$_('statistics.sessions')}</h3>
              <ul class="cs-list">
                {#each cardioSessions.slice(0, 100) as s (s.id)}
                  <li class="cs-row">
                    <div class="cs-main">
                      <span class="cs-activity">{s.activity}</span>
                      <span class="cs-meta">
                        {$_('statistics.n_min', { values: { n: s.duration_min } })}
                        {#if s.distance != null}· {s.distance} {s.distance_unit || 'km'}{/if}
                        {#if s.avg_hr != null}· {$_('statistics.n_bpm', { values: { n: s.avg_hr } })}{/if}
                      </span>
                    </div>
                    <span class="cs-date">{s.date}</span>
                  </li>
                {/each}
              </ul>
              {#if cardioSessions.length > 100}
                <p class="chart-sub" style="text-align:center">{$_('statistics.showing_100_sessions')}</p>
              {/if}
            </div>
          {/if}
        {/if}
      {/if}
    </div>
  {/if}

  <!-- Sticky right rail (>=1280px only via CSS). Range picker moves
       here so it stays visible as the user scrolls through the
       metric's widgets; prior-period delta KPIs surface the existing
       periodDeltas computation that was buried in a tiny chip. -->
  <aside class="stats-rail" aria-label="Range + comparison">
    <div class="rail-card">
      <div class="rail-card-head">
        <span class="material-symbols-rounded">date_range</span>
        <span class="rail-card-title">Range</span>
      </div>
      <div class="rail-range-chips">
        {#each Object.keys(RANGES) as r}
          <button class="range-chip" class:active={range === r} on:click={() => range = r}>{$_(RANGE_LABEL_KEYS[r])}</button>
        {/each}
      </div>
    </div>
    {#if periodDeltas}
      <div class="rail-card">
        <div class="rail-card-head">
          <span class="material-symbols-rounded">compare_arrows</span>
          <span class="rail-card-title">vs Prior {$_(RANGE_LABEL_KEYS[range])}</span>
        </div>
        <div class="rail-delta-stats">
          {#if periodDeltas.volPct != null}
            <div class="rail-delta">
              <span class="rail-delta-label">Volume</span>
              <span class="rail-delta-val"
                    class:up={periodDeltas.volPct > 0}
                    class:down={periodDeltas.volPct < 0}>
                {periodDeltas.volPct > 0 ? '+' : ''}{periodDeltas.volPct}%
              </span>
            </div>
          {/if}
          {#if periodDeltas.cntPct != null}
            <div class="rail-delta">
              <span class="rail-delta-label">Sessions</span>
              <span class="rail-delta-val"
                    class:up={periodDeltas.cntPct > 0}
                    class:down={periodDeltas.cntPct < 0}>
                {periodDeltas.cntPct > 0 ? '+' : ''}{periodDeltas.cntPct}%
              </span>
            </div>
          {/if}
        </div>
        <div class="rail-delta-note">Prior window: {periodDeltas.priorCount} {periodDeltas.priorCount === 1 ? 'session' : 'sessions'}</div>
      </div>
    {/if}
  </aside>
  </div>
</div>

<!-- Exercise picker sheet -->
<!-- Exercise picker for the Exercise Progress metric. Uses the shared
     Sheet component (issue #25) rather than a local inline sheet — the
     duplicated CSS had drifted enough to trigger a Vivaldi-PWA-specific
     off-screen bug on this one screen while other sheets rendered fine.
     Consolidating on Sheet.svelte guarantees the picker inherits the
     same viewport-height + safe-area treatment the rest of the app
     already had working across environments. -->
<Sheet bind:open={showExPicker} title={$_('statistics.choose_exercise')} height="full">
  <div class="ex-picker-search">
    <span class="material-symbols-rounded">search</span>
    <input type="search" bind:value={exSearch} placeholder={$_('statistics.search_exercises_ph')} />
  </div>
  <div class="ex-picker-list">
    {#each filteredExs as ex}
      <button class="ex-picker-row" on:click={() => { selectedExerciseId = ex.id; showExPicker = false; }}>
        <span class="ex-picker-name">{ex.name}</span>
        {#if ex.category}<span class="ex-picker-cat">{ex.category}</span>{/if}
      </button>
    {/each}
    {#if filteredExs.length === 0}
      <p class="ex-picker-empty">{exSearch ? $_('statistics.no_exercises_match') : $_('statistics.no_exercises_library')}</p>
    {/if}
  </div>
</Sheet>

<style>
  .page { min-height: 100dvh; background: var(--bg); padding-bottom: calc(var(--nav-h) + var(--safe-bottom) + var(--mini-player-h, 0px) + 16px); }

  /* Metric pills */
  .metric-bar {
    position: relative;
    display: flex; gap: 6px; padding: 12px var(--page-px) 6px;
    overflow-x: auto; scrollbar-width: none;
  }
  .metric-bar::-webkit-scrollbar { display: none; }
  /* Sliding indicator that rides under the active pill. Top offset matches
     the bar's top padding (12px). Height is the pill height (~34px). */
  .metric-indicator {
    position: absolute;
    top: 12px; left: 0;
    height: 34px;
    background: var(--accent-dim);
    border: 1px solid var(--accent);
    border-radius: var(--radius-full);
    transition: transform 0.26s cubic-bezier(0.22, 1, 0.36, 1),
                width     0.26s cubic-bezier(0.22, 1, 0.36, 1);
    pointer-events: none;
    z-index: 0;
  }
  .metric-pill {
    position: relative;
    z-index: 1;
    display: flex; align-items: center; gap: 6px;
    padding: 8px 14px; border-radius: var(--radius-full);
    background: transparent; border: 1px solid var(--border);
    color: var(--text-2); font-size: 13px; font-weight: 600;
    cursor: pointer; flex-shrink: 0;
    transition: color 0.2s, border-color 0.2s;
    white-space: nowrap;
    font-family: inherit;
  }
  .metric-pill.active { border-color: var(--accent); color: var(--accent); }
  .metric-icon { font-size: 16px; }

  /* Range pills */
  .range-bar {
    display: flex; gap: 4px; padding: 6px var(--page-px) 12px;
    overflow-x: auto; scrollbar-width: none;
    border-bottom: 1px solid var(--border);
  }
  .range-bar::-webkit-scrollbar { display: none; }
  .range-chip {
    padding: 5px 12px; border-radius: var(--radius-full);
    background: var(--surface-2); border: 1px solid var(--border);
    color: var(--text-2); font-size: 12px; font-weight: 600; cursor: pointer; flex-shrink: 0;
    transition: all var(--dur-fast);
  }
  .range-chip.active { background: var(--accent-dim); border-color: var(--accent); color: var(--accent); }

  .content { padding: 16px var(--page-px) 16px; display: flex; flex-direction: column; gap: 16px; }

  /* Summary row */
  .summary-row {
    display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px;
  }
  /* Weekly goal ring — primary widget on the Overview. Arc fills as the
     user completes workouts vs their weekly target; turns success-green
     once the goal is hit. */
  .goal-ring-card {
    display: flex; align-items: center; gap: 16px;
    padding: 14px 16px;
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    margin-bottom: 12px;
  }
  .goal-ring-card.hit { border-color: var(--success); background: color-mix(in srgb, var(--success) 6%, var(--surface-1)); }
  .goal-ring { width: 80px; height: 80px; flex-shrink: 0; transform: rotate(-90deg); }
  .goal-ring-bg { fill: none; stroke: var(--surface-2); stroke-width: 8; }
  .goal-ring-fg {
    fill: none; stroke: var(--accent); stroke-width: 8;
    stroke-linecap: round;
    transition: stroke-dashoffset 0.6s ease-out, stroke 0.2s ease;
  }
  .goal-ring-card.hit .goal-ring-fg { stroke: var(--success); }
  .goal-ring-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
  .goal-ring-top { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px; }
  .goal-ring-num { font-size: 22px; font-weight: 800; color: var(--text-1); font-variant-numeric: tabular-nums; }
  .goal-ring-of  { font-size: 13px; color: var(--text-3); font-weight: 500; }
  .goal-ring-pct { font-size: 12px; font-weight: 700; color: var(--accent); }
  .goal-ring-card.hit .goal-ring-pct { color: var(--success); }

  /* Period-over-period delta chip on the "This {range}" card */
  .sc-delta {
    margin-top: 4px;
    font-size: 11px; font-weight: 700;
    color: var(--text-3);
    font-variant-numeric: tabular-nums;
  }
  .sc-delta.up   { color: var(--success); }
  .sc-delta.down { color: var(--danger); }

  .summary-card {
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: var(--radius-lg); padding: 12px 8px;
    display: flex; flex-direction: column; align-items: center; gap: 2px;
    text-align: center;
  }
  .sc-icon { font-size: 22px; color: var(--accent); margin-bottom: 2px; }
  .sc-value { font-size: 22px; font-weight: 800; color: var(--text-1); line-height: 1; }
  .sc-value-sm { font-size: 18px; font-weight: 700; color: var(--text-1); line-height: 1.2; }
  .sc-value-sm.gain { color: var(--warning); }
  .sc-value-sm.loss { color: var(--info); }
  .sc-label { font-size: 10px; color: var(--text-3); text-transform: uppercase; letter-spacing: 0.04em; font-weight: 600; }
  .sc-spark { margin-top: 6px; width: 84px; max-width: 100%; opacity: 0.85; }

  /* Calorie estimate strip — sits between the 4-card summary row and the
     activity heatmap on the overview tab. Tagged ~est so users don't take
     the number as gospel. */
  .cal-strip {
    display: flex; align-items: center; gap: 8px;
    padding: 10px 14px;
    background: color-mix(in srgb, var(--accent) 8%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent) 22%, transparent);
    border-radius: var(--radius-md);
  }
  .cal-icon  { font-size: 20px; color: var(--accent); }
  .cal-val   { font-size: 16px; font-weight: 800; color: var(--text-1); font-variant-numeric: tabular-nums; }
  .cal-label { font-size: 12px; color: var(--text-3); margin-right: auto; }
  .cal-badge {
    font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--text-3); background: var(--surface-2);
    padding: 2px 6px; border-radius: var(--radius-full);
  }

  /* Chart cards */
  .chart-card {
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: var(--radius-lg); padding: 16px;
  }
  .chart-title {
    font-size: 14px; font-weight: 700; color: var(--text-1); margin: 0 0 12px;
    display: flex; align-items: center; gap: 6px;
  }
  .chart-title-row {
    display: flex; align-items: baseline; justify-content: space-between; gap: 10px;
    flex-wrap: wrap;
    margin: 0 0 12px;
  }
  .chart-title-row .chart-title { margin: 0; }
  .chart-legend { display: flex; gap: 10px; flex-wrap: wrap; }
  .legend-item {
    display: inline-flex; align-items: center; gap: 5px;
    font-size: 10px; font-weight: 600; color: var(--text-3);
  }
  .legend-swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; }
  .legend-swatch.accent { background: var(--accent); }
  .legend-swatch.rpe    { background: var(--warning, #FFB020); }
  .chart-sub { font-size: 12px; color: var(--text-3); margin: 10px 0 0; text-align: center; }
  .chart-desc { font-size: 12px; color: var(--text-3); margin: -8px 0 12px; line-height: 1.4; }
  .chart-footer { display: flex; justify-content: space-between; font-size: 11px; color: var(--text-3); margin-top: 6px; }

  /* Solo stat — shown when only one data point exists and a bar chart would be meaningless */
  .solo-stat {
    display: flex; flex-direction: column; align-items: center;
    padding: 24px 16px;
    background: linear-gradient(135deg, var(--accent-dim), transparent);
    border-radius: var(--radius-md);
    gap: 6px;
  }
  .solo-value { font-size: 28px; font-weight: 800; color: var(--accent); line-height: 1; font-variant-numeric: tabular-nums; }
  .solo-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-3); font-weight: 600; }

  /* Bar chart */
  .bar-chart {
    display: flex; align-items: flex-end; gap: 4px;
    height: 120px; padding: 0 2px;
  }
  .bar-col {
    flex: 1; display: flex; flex-direction: column; align-items: center; gap: 4px;
    height: 100%; justify-content: flex-end; min-width: 0;
  }
  .bar {
    width: 100%; min-height: 4px;
    background: linear-gradient(180deg, var(--accent), var(--accent-2));
    border-radius: 3px 3px 0 0;
    transition: height var(--dur-slow);
  }
  .bar.freq { background: linear-gradient(180deg, var(--info), var(--accent-2)); }
  .bar-label { font-size: 9px; color: var(--text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }

  /* Line chart */
  .line-chart { width: 100%; height: 140px; display: block; }

  /* Heatmap */
  .heatmap { display: grid; grid-template-columns: repeat(13, 1fr); gap: 3px; margin: 8px 0; }
  .hm-cell { aspect-ratio: 1; border-radius: 3px; background: var(--surface-3); }
  .hm-cell.hm-active { background: var(--accent); }
  .hm-cell.hm-today { outline: 2px solid var(--text-1); outline-offset: -1px; }
  .hm-legend {
    display: flex; justify-content: space-between; align-items: center;
    font-size: 11px; color: var(--text-3); margin-top: 6px;
  }
  .hm-legend-scale { display: flex; align-items: center; gap: 6px; }
  .hm-legend-scale .hm-cell { width: 12px; height: 12px; flex-shrink: 0; }

  /* Records */
  .section { display: flex; flex-direction: column; gap: 8px; }
  .section-title { font-size: 14px; font-weight: 700; color: var(--text-1); margin: 0; display: flex; align-items: center; gap: 6px; }
  .section-title .material-symbols-rounded { font-size: 18px; color: var(--accent); }

  .records-list { display: flex; flex-direction: column; gap: 6px; }
  .record-row {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 14px;
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: var(--radius-md);
    width: 100%; font-family: inherit; text-align: left;
    gap: 8px;
  }
  .record-row.linked { cursor: pointer; transition: background var(--dur-fast), border-color var(--dur-fast); }
  .record-row.linked:hover { background: var(--surface-2); border-color: var(--accent); }
  .record-row.linked:active { transform: scale(0.995); }
  .record-chev { color: var(--text-3); font-size: 18px; flex-shrink: 0; }
  .record-name { font-size: 14px; font-weight: 600; color: var(--text-1); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .record-data { display: flex; flex-direction: column; align-items: flex-end; gap: 1px; flex-shrink: 0; }
  .record-weight { font-size: 14px; font-weight: 700; color: var(--accent); }
  .record-meta { font-size: 11px; color: var(--text-3); }

  /* Body-map legend + not-trained chip row (rendered inside .chart-card
     under Muscle Balance). Colours mirror the .bm-m.l0…l4 scale in
     BodyMap.svelte so users can eyeball "these three muscles are l4"
     off the SVG. */
  .bm-legend {
    display: flex; align-items: center; gap: 6px;
    justify-content: center;
    margin-top: 10px;
    font-size: 11px; color: var(--text-3);
  }
  .bm-legend-swatch {
    width: 16px; height: 12px; border-radius: 3px;
    border: 1px solid color-mix(in srgb, var(--text-3) 30%, transparent);
  }
  .bm-legend-swatch.l0 { background: color-mix(in srgb, var(--text-3) 25%, transparent); }
  .bm-legend-swatch.l1 { background: color-mix(in srgb, var(--accent) 25%, transparent); }
  .bm-legend-swatch.l2 { background: color-mix(in srgb, var(--accent) 50%, transparent); }
  .bm-legend-swatch.l3 { background: color-mix(in srgb, var(--accent) 75%, transparent); }
  .bm-legend-swatch.l4 { background: var(--accent); }

  .bm-missed { margin-top: 14px; }
  .bm-missed-title {
    font-size: 11px; font-weight: 700; letter-spacing: 0.05em;
    text-transform: uppercase; color: var(--text-3);
    margin: 0 0 6px;
  }
  .bm-chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .bm-chip {
    padding: 3px 8px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    font-size: 11px; font-weight: 600; color: var(--text-2);
  }

  /* List card (history) */
  .list-card {
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: var(--radius-lg); padding: 14px 16px;
  }
  .history-row {
    display: flex; justify-content: space-between; align-items: center;
    padding: 8px 0; border-bottom: 1px solid var(--border);
    font-size: 13px;
  }
  .history-row:last-child { border-bottom: none; }
  .hr-date { color: var(--text-3); }
  .hr-value { color: var(--text-1); font-weight: 600; }

  /* Exercise picker button */
  .ex-picker-btn {
    display: flex; align-items: center; gap: 8px;
    width: 100%; padding: 14px 16px;
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    color: var(--text-1); font-size: 14px; font-weight: 600;
    cursor: pointer; text-align: left;
  }
  .ex-picker-btn:hover { background: var(--surface-2); }
  .ex-picker-btn .material-symbols-rounded { color: var(--text-3); font-size: 20px; }

  /* Picker inner styles — the wrapping sheet + backdrop live in
     Sheet.svelte now (issue #25). These style the content slotted
     into it: the search bar, the results list, and the empty-state. */
  .ex-picker-search {
    display: flex; align-items: center; gap: 8px;
    margin: 0 0 12px;
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-md); padding: 0 12px;
  }
  .ex-picker-search .material-symbols-rounded { color: var(--text-3); font-size: 20px; }
  .ex-picker-search input {
    flex: 1; background: none; border: none; outline: none;
    color: var(--text-1); font-size: 15px; padding: 10px 0; font-family: inherit;
  }
  .ex-picker-list { display: flex; flex-direction: column; gap: 6px; }
  .ex-picker-row {
    display: flex; justify-content: space-between; align-items: center;
    width: 100%; padding: 12px;
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-md);
    cursor: pointer; text-align: left;
    color: var(--text-1); font-size: 14px; font-weight: 500;
  }
  .ex-picker-row:hover { background: var(--surface-3); }
  .ex-picker-cat { font-size: 11px; color: var(--text-3); text-transform: capitalize; }
  .ex-picker-empty {
    font-size: 13px; color: var(--text-3);
    margin: 24px 0 0; text-align: center;
  }

  /* Empty / loading */
  .empty-state {
    display: flex; flex-direction: column; align-items: center; gap: 12px;
    padding: 48px 24px; text-align: center;
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: var(--radius-lg);
  }
  .empty-state .material-symbols-rounded { font-size: 40px; color: var(--text-3); }
  .empty-state p { font-size: 13px; color: var(--text-2); margin: 0; line-height: 1.5; max-width: 32em; }
  .empty-title { font-size: 15px; font-weight: 700; color: var(--text-1); margin: 0; }
  .loading { text-align: center; padding: 48px; color: var(--text-3); font-size: 14px; }

  @media (max-width: 400px) {
    .summary-row { grid-template-columns: repeat(2, 1fr); }
  }

  /* Mobile default — sticky rail hidden. Range bar at top of page
     still visible so mobile flow is unchanged. */
  .stats-rail { display: none; }

  /* ────────────────────────────────────────────────────────────
     Statistics Phase 1 — wide-layout correctness + containment.
     Two real problems on wide monitors:
       (1) SVG line charts use preserveAspectRatio="none" and
           stretch to full viewport width × 140px tall. On 1600px
           a real progression slope compresses to a near-flat
           ribbon — misrepresents the data, not just polish.
       (2) .content is edge-to-edge; summary cards balloon to
           400px each with 22px numbers floating in dead space.
     Phase 1 fixes both without changing the layout structure:
     cap .content max-width + center it; cap .line-chart max-
     width so aspect distortion stays contained; wrap the
     .metric-bar + .range-bar chips to multi-line so nothing
     scrolls when there's room to lay flat. Later phases add
     the rail + per-metric dashboards. Gated by
     html:not(.force-mobile-layout) + >=1280px. */
  @media (min-width: 1280px) {
    /* Phase 2 shell — 2-col grid: content on the left, sticky
       right rail on the right. The Phase 1 cap on .content is
       superseded here (grid manages width now). */
    :global(html:not(.force-mobile-layout)) .stats-body {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 320px;
      gap: 20px;
      align-items: start;
      max-width: 1440px;
      margin: 0 auto;
      padding: 0 var(--page-px);
      box-sizing: border-box;
    }
    :global(html:not(.force-mobile-layout)) .stats-body > .content {
      max-width: none;
      margin: 0;
      padding-left: 0;
      padding-right: 0;
      min-width: 0;
    }
    /* Top range-bar hidden on wide — the rail owns range now. */
    :global(html:not(.force-mobile-layout)) .range-bar {
      display: none;
    }
    :global(html:not(.force-mobile-layout)) .metric-bar {
      flex-wrap: wrap;
      overflow-x: visible;
      max-width: 1440px;
      margin-left: auto;
      margin-right: auto;
      padding-left: var(--page-px);
      padding-right: var(--page-px);
      box-sizing: border-box;
    }
    /* Sticky rail — same shell math the Diary rail uses. */
    :global(html:not(.force-mobile-layout)) .stats-body > .stats-rail {
      display: flex;
      flex-direction: column;
      gap: 12px;
      position: sticky;
      top: calc(var(--page-top, var(--safe-top)) + 130px + var(--hamburger-row, 0px));
      align-self: start;
      max-height: calc(100vh
        - var(--page-top, var(--safe-top))
        - 150px
        - var(--hamburger-row, 0px)
        - var(--nav-h, 0px)
        - var(--safe-bottom, 0px));
      overflow-y: auto;
      scrollbar-width: thin;
      scrollbar-color: var(--border) transparent;
    }
    /* Rail cards — matches the tokens used in Diary rail, Programs
       preview pane, and ProgramDetail template pane. */
    :global(html:not(.force-mobile-layout)) .stats-body > .stats-rail > .rail-card {
      background: var(--surface-1);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: 12px 14px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    :global(html:not(.force-mobile-layout)) .stats-body > .stats-rail > .rail-card > .rail-card-head {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      font-weight: 600;
      color: var(--text-1);
    }
    :global(html:not(.force-mobile-layout)) .stats-body > .stats-rail > .rail-card > .rail-card-head > .material-symbols-rounded {
      font-size: 18px;
      color: var(--accent);
    }
    :global(html:not(.force-mobile-layout)) .stats-body > .stats-rail > .rail-card > .rail-card-head > .rail-card-title {
      flex: 1;
      min-width: 0;
    }
    :global(html:not(.force-mobile-layout)) .stats-body > .stats-rail > .rail-card > .rail-range-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    :global(html:not(.force-mobile-layout)) .stats-body > .stats-rail > .rail-card > .rail-range-chips > .range-chip {
      flex: 0 0 auto;
    }
    :global(html:not(.force-mobile-layout)) .stats-body > .stats-rail > .rail-card > .rail-delta-stats {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .rail-delta {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
    }
    .rail-delta-label {
      font-size: 12px;
      color: var(--text-3);
    }
    .rail-delta-val {
      font-size: 18px;
      font-weight: 700;
      color: var(--text-1);
      font-variant-numeric: tabular-nums;
    }
    .rail-delta-val.up   { color: var(--success); }
    .rail-delta-val.down { color: var(--danger);  }
    .rail-delta-note {
      font-size: 11px;
      color: var(--text-3);
      font-style: italic;
    }

    /* ── Phase 3: per-metric dashboards ────────────────────────
       Overview restructures its vertical stack into a 2-col grid
       so the "am I on track this week?" answer lands in one
       glance instead of a scroll. Full-width items (goal ring,
       summary row, cal strip, empty state) span both cols; the
       remaining widgets pair up. */
    :global(html:not(.force-mobile-layout)) .overview-body {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      column-gap: 16px;
      row-gap: 16px;
      align-items: start;
    }
    :global(html:not(.force-mobile-layout)) .overview-body > .goal-ring-card,
    :global(html:not(.force-mobile-layout)) .overview-body > .summary-row,
    :global(html:not(.force-mobile-layout)) .overview-body > .cal-strip,
    :global(html:not(.force-mobile-layout)) .overview-body > .empty-state {
      grid-column: 1 / -1;
    }

    /* Muscle Balance dashboard — hero the BodyMap on the left,
       stack the legend / not-trained chips / effective-sets note
       in a scannable column on the right. Title + description
       still span the top full width. */
    :global(html:not(.force-mobile-layout)) .muscle-balance-card {
      display: grid;
      grid-template-columns: minmax(280px, 380px) minmax(0, 1fr);
      column-gap: 24px;
      row-gap: 8px;
      align-items: start;
    }
    :global(html:not(.force-mobile-layout)) .muscle-balance-card > .chart-title,
    :global(html:not(.force-mobile-layout)) .muscle-balance-card > .mb-desc {
      grid-column: 1 / -1;
    }
    :global(html:not(.force-mobile-layout)) .muscle-balance-card > .mb-body-col {
      grid-column: 1;
    }
    :global(html:not(.force-mobile-layout)) .muscle-balance-card > .mb-detail-col {
      grid-column: 2;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
  }
  /* Below 1280 — muscle-balance columns collapse; explicit rules so
     the wrapper divs stack cleanly on mobile without any grid. */
  .mb-desc { margin-top: -4px; margin-bottom: 12px; }
  .mb-effective { margin-top: 14px; }
    /* Cap line-chart width so preserveAspectRatio="none" can't
       stretch a short data series into a near-flat horizontal
       ribbon at desktop widths. The chart centers within its
       card so it still reads as the primary content. */
    :global(html:not(.force-mobile-layout)) .line-chart {
      max-width: 900px;
      margin: 0 auto;
    }
    /* Same treatment for the SVG-based bar charts inside
       chart-cards so their bars don't stretch to 100px-wide
       gaps on ultra-wide monitors. */
    :global(html:not(.force-mobile-layout)) .chart-card {
      max-width: 1000px;
      margin-left: auto;
      margin-right: auto;
      width: 100%;
    }
    /* Cap summary-row width so each of the 4 tiles stays visually
       weighted — a 22px number in a 400px empty tile looks like
       loading skeleton. */
    :global(html:not(.force-mobile-layout)) .summary-row {
      max-width: 1000px;
      margin-left: auto;
      margin-right: auto;
      width: 100%;
    }
  }

  /* Cardio weekly-minutes bars. Same visual language as the frequency
     chart: accent fill grows with training, target-hit weeks flip to
     success green. --target-frac is set inline so the horizontal target
     line renders at the right height. */
  .cw-bars {
    position: relative;
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: minmax(0, 1fr);
    align-items: end;
    gap: 4px;
    height: 140px;
    padding-top: 8px;
    border-bottom: 1px solid var(--border);
  }
  .cw-bars::before {
    content: '';
    position: absolute;
    left: 0; right: 0;
    bottom: calc(var(--target-frac, 0) * 100% * 0.94);
    height: 1px;
    background: color-mix(in srgb, var(--accent) 40%, transparent);
    border-top: 1px dashed color-mix(in srgb, var(--accent) 60%, transparent);
    background: transparent;
    display: var(--target-frac, none);
    pointer-events: none;
  }
  .cw-col {
    display: flex; flex-direction: column; justify-content: flex-end;
    align-items: center;
    height: 100%;
    gap: 4px;
  }
  .cw-fill {
    width: 100%;
    background: linear-gradient(180deg, var(--accent), color-mix(in srgb, var(--accent) 60%, transparent));
    border-radius: 3px 3px 0 0;
    min-height: 2px;
    transition: height var(--dur-slow, 400ms);
  }
  .cw-fill.hit { background: linear-gradient(180deg, var(--success, #2FD66F), color-mix(in srgb, var(--success, #2FD66F) 60%, transparent)); }
  .cw-label { font-size: 10px; color: var(--text-3); font-variant-numeric: tabular-nums; }
  .sc-sub { font-size: 13px; color: var(--text-3); font-weight: 600; }

  /* Cardio session list under the weekly chart. Compact rows, newest
     first, date on the right. Read-only here — editing happens on the
     Diary CardioCard because that's where the date context lives. */
  .cs-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 6px; }
  .cs-row {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    padding: 8px 10px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
  .cs-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .cs-activity { font-size: 13px; font-weight: 700; color: var(--text-1); }
  .cs-meta { font-size: 12px; color: var(--text-3); font-variant-numeric: tabular-nums; }
  .cs-date { font-size: 11px; color: var(--text-3); font-variant-numeric: tabular-nums; flex-shrink: 0; }
</style>
