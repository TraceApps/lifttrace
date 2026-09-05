<script>
  import { onMount, onDestroy } from 'svelte';
  import { push } from 'svelte-spa-router';
  import { _ } from 'svelte-i18n';
  import { isNative, getServerUrl } from '../lib/platform.js';
  import { currentDate, todayLog, loadWorkout, saveWorkout, completedSetsToday, activeProgram, loadActiveProgram, todayPrescription } from '../stores/workout.js';
  import { weightUnit, screenKeepAwake, pageBanners, bannerStyle, restTimerEnabled, restAutoStart, restDuration, autoFillLastWeights, showCompletionSummary, exerciseReorderMethod, autoCollapseCompleted, autoNameWorkouts, confirmExerciseRemoval, autoGenerateWarmups, exerciseLoadTypes, caloriesBurnedEnabled, currentWeightKg, heightCm, ntFederationEnabled, cardioEnabled } from '../stores/settings.js';
  import { screenOn, enableWakeLock, disableWakeLock, toggleWakeLock } from '../stores/wakeLock.js';
  import { timerState, timerMs, pauseTimer, resetTimer, formatTimerMs } from '../stores/workoutTimer.js';
  import WorkoutSummary from '../components/diary/WorkoutSummary.svelte';
  import { celebrateWorkoutComplete, celebratePR, requestPermission } from '../lib/notifications.js';
  import { estimateWorkoutCalories, ageFromDob } from '../lib/workout.js';
  import Spinner from '../components/ui/Spinner.svelte';
  import { startRest as startRestTimer, stopRest } from '../stores/restTimer.js';
  import BodyStats from '../components/diary/BodyStats.svelte';
  import GymTools from '../components/diary/GymTools.svelte';
  import { showSuccess, showError } from '../stores/toast.js';
  import { localDateStr } from '../lib/db.js';
  import { LtApi } from '../lib/api.js';
  import { confirmDialog } from '../stores/confirmDialog.js';
  import { currentUser } from '../stores/auth.js';
  import { resolveAssetUrl } from '../lib/platform.js';
  import { dateFormat } from '../stores/settings.js';
  import { fmtWeight, fmtDuration, countCompletedSets, generateWarmupSets, calc1RM, exerciseVolume, setVolume } from '../lib/workout.js';
  import ExerciseCard from '../components/diary/ExerciseCard.svelte';
  import SupersetCard from '../components/diary/SupersetCard.svelte';
  import WorkoutTimer from '../components/diary/WorkoutTimer.svelte';
  import CardioCard from '../components/diary/CardioCard.svelte';
  import BodyStatsWidget from '../components/diary/BodyStatsWidget.svelte';
  import ExercisePicker from '../components/exercises/ExercisePicker.svelte';
  import ExerciseInfoSheet from '../components/exercises/ExerciseInfoSheet.svelte';
  import SmartLogModal from '../components/diary/SmartLogModal.svelte';
  import Sheet from '../components/ui/Sheet.svelte';
  import { portal } from '../lib/portal.js';
  import { fade, fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import ActionSheet from '../components/ui/ActionSheet.svelte';

  let showPicker = false;
  let showSmartLog = false;

  async function handleSmartLogSave(mergedExercises) {
    await saveWorkout($currentDate, { ...($todayLog || {}), exercises: mergedExercises });
  }
  let showLoadWorkout = false;
  let showWorkoutActions = false;
  let showDatePicker = false;
  let notes = '';
  let notesExpanded = false;
  let loading = true;
  let editingName = false;
  let editNameValue = '';

  // ── Rest timer ────────────────────────────────────────────────────────
  let showBodyStats = false;
  let showGymTools = false;
  let showSummary = false;

  // ── Calendar picker state ──────────────────────────────────────────
  let calYear  = new Date().getFullYear();
  let calMonth = new Date().getMonth();
  let showYearPicker = false;
  let showMonthPicker = false;
  $: calFirstDay    = new Date(calYear, calMonth, 1).getDay();
  $: calDaysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  $: calMonthName   = new Date(calYear, calMonth, 1).toLocaleDateString(undefined, { month: 'long' });
  $: yearRange      = Array.from({ length: 22 }, (_, i) => (new Date().getFullYear() - 10) + i);
  const DAY_LABELS  = ['Su','Mo','Tu','We','Th','Fr','Sa'];

  // PR detection: cache the previous best (top weight + top estimated 1RM)
  // per exercise once when the workout loads. prFlagsByIdx is reactive on
  // exercises + cache, so flagging fresh PR sets is instant while logging.
  let prevBestsByExId = {};
  async function loadPrevBests() {
    if (!exercises.length) { prevBestsByExId = {}; return; }
    const newBests = {};
    const uniqueIds = [...new Set(exercises.map(e => e.exercise_id).filter(Boolean))];
    await Promise.all(uniqueIds.map(async id => {
      try {
        const history = await LtApi.getWorkoutHistory(id);
        const prior = (history || []).filter(h => h.date !== $currentDate);
        let topW = 0, topE = 0;
        for (const h of prior) {
          for (const s of (h.sets || [])) {
            if (!s.completed || s.warmup) continue;
            const w = s.weight || 0, r = s.reps || 0;
            if (w > topW) topW = w;
            const e = w * (1 + r / 30);
            if (e > topE) topE = e;
          }
        }
        newBests[id] = { topWeight: topW, topE1rm: topE };
      } catch {}
    }));
    prevBestsByExId = newBests;
  }

  // For each exercise position in the current workout, which set indices
  // are PRs (top weight OR top estimated 1RM beats the prior best).
  $: prFlagsByIdx = (() => {
    const out = {};
    (exercises || []).forEach((ex, exIdx) => {
      const best = prevBestsByExId[ex.exercise_id];
      if (!best) return;
      const indices = new Set();
      (ex.sets || []).forEach((s, sIdx) => {
        if (!s.completed || s.warmup) return;
        const w = s.weight || 0;
        const r = s.reps || 0;
        if (!w || !r) return;
        const e1rm = w * (1 + r / 30);
        if (w > best.topWeight || e1rm > best.topE1rm) indices.add(sIdx);
      });
      if (indices.size) out[exIdx] = indices;
    });
    return out;
  })();
  $: prCountToday = Object.values(prFlagsByIdx).reduce((sum, s) => sum + s.size, 0);

  let workoutDateSet = new Set();
  async function loadWorkoutDates() {
    try {
      const rows = await LtApi.getRecentWorkouts(365);
      workoutDateSet = new Set(rows.filter(r => {
        // Only count days with at least one completed set
        const exs = typeof r.exercises === 'string' ? JSON.parse(r.exercises || '[]') : (r.exercises || []);
        return exs.some(e => (e.sets || []).some(s => s.completed));
      }).map(r => r.date));
    } catch {}
  }

  // Current streak from workoutDateSet — consecutive days back from today
  // (or yesterday, so the user doesn't lose their streak the moment a new
  // day starts before they've logged). Returns 0 if neither today nor
  // yesterday has a workout. Reactive so it updates when the diary saves
  // a fresh completed set and workoutDateSet is reloaded.
  $: streakCount = (() => {
    if (!workoutDateSet.size) return 0;
    const today = localDateStr();
    const yest = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return localDateStr(d); })();
    // Pick the latest "anchor" — today first, fall back to yesterday so
    // the streak survives the morning grace period.
    let anchor;
    if (workoutDateSet.has(today)) anchor = today;
    else if (workoutDateSet.has(yest)) anchor = yest;
    else return 0;
    let count = 0;
    const d = new Date(anchor + 'T12:00:00');
    while (workoutDateSet.has(localDateStr(d))) {
      count++;
      d.setDate(d.getDate() - 1);
    }
    return count;
  })();
  // Desktop right-rail visibility toggle. 'pinned' = default sticky
  // sidebar; 'hidden' = rail collapses to a fixed edge-tab so the
  // center column reclaims that width. Persists per-device so a
  // heads-down lifter's preference sticks between sessions. Mirrors
  // NutriTrace's Diary rail pattern (nt:diaryRailMode) — LT-scoped
  // key. Reactive save writes back on every change.
  // Rail mode + overlay state — ported 1:1 from NT so LT's Diary
  // right rail behaves identically. Three surfaces:
  //   pinned — rail sits in the desktop grid (default)
  //   hidden — rail folded out of the grid; a portaled edge tab
  //     hovers on the right of the viewport. Clicking it flips
  //     `_railOverlay` and slides the rail back in as a fixed
  //     overlay above the page content, without reclaiming the
  //     grid column.
  //   hidden + overlay — the overlay carries a pin button that
  //     returns to 'pinned', and a close button that dismisses
  //     the overlay while staying in 'hidden'.
  // `_railMode` persists to localStorage; overlay is transient.
  const RAIL_MODE_KEY = 'lt:diaryRailMode';
  let _railMode = 'pinned';
  let _railOverlay = false;
  if (typeof localStorage !== 'undefined') {
    const saved = localStorage.getItem(RAIL_MODE_KEY);
    if (saved === 'hidden' || saved === 'pinned') _railMode = saved;
  }
  function _persistRailMode() {
    try { localStorage.setItem(RAIL_MODE_KEY, _railMode); } catch { /* ignore */ }
  }
  function railPin() {
    _railMode = 'pinned';
    _railOverlay = false;
    _persistRailMode();
  }
  function railHide() {
    _railMode = 'hidden';
    _railOverlay = false;
    _persistRailMode();
  }
  function railToggleOverlay() {
    if (_railMode !== 'hidden') return;
    _railOverlay = !_railOverlay;
  }

  // Viewport-width tracker so the edge tab + overlay only show
  // where the desktop grid actually rendered. Same media query
  // the .diary-body layout uses.
  let _wideViewport = false;
  function _syncWideViewport() {
    if (typeof window === 'undefined') return;
    _wideViewport = window.matchMedia('(min-width: 1280px)').matches;
  }

  // Rail measurement — the pinned rail is portaled to document.body
  // so position:fixed resolves against the viewport (not against
  // .page-transition, which has will-change:transform + is itself
  // fixed, breaking fixed positioning for descendants). JS reads
  // the grid's live bounding rect and pushes it into three CSS
  // variables so the aside sits exactly on top of the reserved
  // 340px column even though it's now outside the flow.
  let _railStickyTopPx = 0;   // exposed as --diary-rail-top
  let _railFixedLeftPx = 0;   // exposed as --diary-rail-left
  let _railFixedWidthPx = 340; // exposed as --diary-rail-width
  let _diaryRightRailEl = null;
  let _diaryBodyEl = null;
  function _measureRail() {
    if (!_diaryBodyEl) return;
    const gridRect = _diaryBodyEl.getBoundingClientRect();
    const colWidth = _railFixedWidthPx;
    const leftPx = Math.max(0, Math.round(gridRect.right - colWidth));
    const scrollY = window.scrollY || document.documentElement.scrollTop || 0;
    const pad = parseFloat(getComputedStyle(_diaryBodyEl).paddingTop || '0') || 0;
    const naturalDocTop = gridRect.top + scrollY + pad;
    const rootCS = getComputedStyle(document.documentElement);
    const pageTop = parseFloat(rootCS.getPropertyValue('--page-top') || rootCS.getPropertyValue('--safe-top') || '0') || 0;
    const hamRow  = parseFloat(rootCS.getPropertyValue('--hamburger-row') || '0') || 0;
    const topPx = Math.max(0, Math.round(naturalDocTop - pageTop - hamRow));
    if (topPx  !== _railStickyTopPx)  _railStickyTopPx  = topPx;
    if (leftPx !== _railFixedLeftPx)  _railFixedLeftPx  = leftPx;
  }
  let _railResizeObs = null;

  // 7-day peek for the desktop right rail. Returns the last 7 dates
  // (oldest first, today last) with a flag for whether workoutDateSet
  // has a completed workout that day. Reactive on workoutDateSet so it
  // updates as new sessions land.
  $: weekPeekDays = (() => {
    const out = [];
    const base = new Date();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(base);
      d.setDate(base.getDate() - i);
      const key = localDateStr(d);
      out.push({
        key,
        dow: d.toLocaleDateString(undefined, { weekday: 'narrow' }),
        dom: d.getDate(),
        done: workoutDateSet.has(key),
        isToday: i === 0,
      });
    }
    return out;
  })();
  $: weekWorkoutCount = weekPeekDays.filter(d => d.done).length;

  function calHasWorkout(day) {
    const key = `${calYear}-${String(calMonth+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    return workoutDateSet.has(key);
  }

  function openDatePicker() {
    const d = new Date($currentDate + 'T12:00:00');
    calYear  = d.getFullYear();
    calMonth = d.getMonth();
    showYearPicker  = false;
    showMonthPicker = false;
    showDatePicker  = true;
    loadWorkoutDates();
  }
  function calPrevMonth() { if (calMonth === 0) { calYear--; calMonth = 11; } else calMonth--; }
  function calNextMonth() { if (calMonth === 11) { calYear++; calMonth = 0; } else calMonth++; }
  function calPickDay(day) {
    const m = String(calMonth + 1).padStart(2, '0');
    const d = String(day).padStart(2, '0');
    const dateStr = `${calYear}-${m}-${d}`;
    showDatePicker = false;
    loadWorkout(dateStr).then(() => { notes = $todayLog?.notes || ''; loadCoachFeedback(dateStr); });
  }
  function calPickYear(y)  { calYear = y; showYearPicker = false; }
  function calPickMonth(m) { calMonth = m; showMonthPicker = false; }
  function calIsToday(day)  { const t = localDateStr(); return `${calYear}-${String(calMonth+1).padStart(2,'0')}-${String(day).padStart(2,'0')}` === t; }
  function calIsSel(day)    { return `${calYear}-${String(calMonth+1).padStart(2,'0')}-${String(day).padStart(2,'0')}` === $currentDate; }

  function formatDateSub(dateStr) {
    const d = new Date(dateStr + 'T12:00:00');
    if ($dateFormat === 'EU') return d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
    if ($dateFormat === 'ISO') return dateStr;
    return d.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
  }


  // Program templates for "Load Workout" sheet
  let programs = [];
  let loadingPrograms = false;
  let selectedProgram = null;

  // Template preview — info icon on each row in the Load Workout sheet
  // opens a second sheet showing what's inside the template (exercises +
  // target sets/reps/weight + superset groupings) so the user can decide
  // before loading. Mirrors NutriTrace's meal/recipe info-button pattern
  // on the Foods picker.
  let templateInfo = null; // null = closed, else the template object
  function openTemplateInfo(t) { templateInfo = t; }
  function loadFromInfo() {
    const t = templateInfo;
    templateInfo = null;
    if (t) loadTemplate(t);
  }
  function _fmtTplExerciseTarget(ex) {
    // Per-set spec wins when present (template author pinned each set);
    // otherwise fall back to the uniform sets/reps/weight target row.
    if (ex.set_specs?.length) {
      return ex.set_specs.map(s => {
        const w = s.weight ? `${s.weight}${$weightUnit}` : '';
        const r = s.reps || '—';
        return w ? `${r}×${w}` : `${r} reps`;
      }).join(', ');
    }
    const sets = ex.target_sets || 1;
    const reps = ex.target_reps || '—';
    const w = ex.target_weight ? `${ex.target_weight}${$weightUnit}` : '';
    return w ? `${sets}×${reps} @ ${w}` : `${sets}×${reps}`;
  }

  $: exercises = $todayLog?.exercises || [];
  $: workoutName = $todayLog?.name || '';
  $: stats = countCompletedSets(exercises);
  $: durationMin = $todayLog?.duration_min || 0;
  // Progress-strip stats (session-level): total volume moved on completed
  // sets. Uses the load-type-aware helper so per-side / alternating
  // exercises contribute the correct multiplier.
  $: totalVolume = exercises.reduce((sum, ex) => sum + exerciseVolume(ex), 0);
  $: showProgressStrip = exercises.length > 0 && (stats.completed > 0 || $timerState === 'running' || $timerState === 'paused');

  // "Now doing" — the first exercise with any incomplete working set. Tapping
  // the floating pill scrolls directly to its card. For supersets we report
  // the superset group as a single "Superset: A / B" label.
  $: currentStatus = (() => {
    for (let i = 0; i < exercises.length; i++) {
      const ex = exercises[i];
      const working = (ex.sets || []).filter(s => !s.warmup);
      if (working.length === 0) continue;
      const done = working.filter(s => s.completed).length;
      if (done >= working.length) continue;
      // Found it. Figure out if it's in a superset.
      const ssId = ex.superset_id;
      if (ssId != null && ex.superset_size > 1) {
        const group = exercises.filter(e => e.superset_id === ssId);
        const firstIdx = exercises.findIndex(e => e.superset_id === ssId);
        const names = group.map(g => g.exercise_name).filter(Boolean).slice(0, 2);
        return {
          label: `Superset: ${names.join(' / ')}`,
          setInfo: `Set ${done + 1} of ${working.length}`,
          anchorIdx: firstIdx,
          isSuperset: true,
        };
      }
      return {
        label: ex.exercise_name || `Exercise ${i + 1}`,
        setInfo: `Set ${done + 1} of ${working.length}`,
        anchorIdx: i,
        isSuperset: false,
      };
    }
    return null;
  })();

  function scrollToCurrent() {
    if (!currentStatus) return;
    const el = document.querySelector(`[data-ex-idx="${currentStatus.anchorIdx}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  $: showDragReorder = $exerciseReorderMethod === 'drag' || $exerciseReorderMethod === 'both';
  $: showReorderButtons = $exerciseReorderMethod === 'buttons' || $exerciseReorderMethod === 'both';

  // Group exercises by superset_id
  $: supersetGroups = (() => {
    const groups = [];
    let i = 0;
    while (i < exercises.length) {
      const ex = exercises[i];
      const ssId = ex.superset_id;
      if (ssId != null && ex.superset_size > 1) {
        const group = [];
        const startI = i;
        while (i < exercises.length && exercises[i].superset_id === ssId) {
          group.push(exercises[i]);
          i++;
        }
        groups.push({ type: 'superset', startIdx: startI, exercises: group, supersetId: ssId, targetSets: group[0]?.target_sets || 1 });
      } else {
        groups.push({ type: 'single', startIdx: i, exercises: [ex] });
        i++;
      }
    }
    return groups;
  })();

  // Workout action sheet items (dynamic — includes timer reset when active)
  $: workoutActions = [
    { label: 'Replace Workout', icon: 'swap_horiz', value: 'replace' },
    { label: 'Copy From Yesterday', icon: 'content_copy', value: 'copy_yesterday' },
    ...($timerState ? [{ label: 'Reset Timer', icon: 'timer_off', value: 'reset_timer' }] : []),
    { label: 'Clear Workout', icon: 'delete_sweep', value: 'clear', danger: true },
  ];
  // Small helper so the inline rail card can trigger the same action
  // path the mobile ActionSheet uses, without simulating a select event
  // shape at every call site.
  const _runWorkoutAction = (value) => handleWorkoutAction({ detail: { value } });

  // Undated "anytime" prescriptions from the user's coach. Surfaced as a
  // "Suggested by your coach" card so the member can pick one and start it
  // today — until this lands they were created server-side and rendered
  // nowhere on the member's diary.
  let suggestedPrescriptions = [];
  async function loadSuggestedPrescriptions() {
    try {
      const all = await LtApi.getMyUpcomingPrescriptions();
      // Filter to UNDATED only — dated ones already show via the existing
      // todayPrescription banner on their assigned day.
      suggestedPrescriptions = (all || []).filter(p => !p.date);
    } catch { suggestedPrescriptions = []; }
  }

  // Coach feedback for the current date. Loaded separately because the
  // diary's workout GET is served local-first from SQLite which has no
  // feedback table — without this the workout banner + per-exercise notes
  // would stay invisible to the member until a cache miss.
  async function loadCoachFeedback(dateStr) {
    try {
      const fb = await LtApi.getWorkoutFeedback(dateStr);
      // Merge into todayLog so the existing render path picks it up.
      todayLog.update(curr => curr ? { ...curr, feedback: fb || [] } : curr);
    } catch { /* server old / offline — leave existing feedback alone */ }
  }

  // Coachee reply state. Keyed by feedback id so each note has its own
  // open/closed + draft state. Saving an empty reply clears it server-side.
  let replyDrafts = {};
  let replyOpenId = null;
  let replySaving = null;

  function openReply(fb) {
    replyOpenId = fb.id;
    if (!(fb.id in replyDrafts)) replyDrafts[fb.id] = fb.member_reply || '';
    replyDrafts = replyDrafts;
    // Tapping Reply counts as acknowledging the note — mark seen on the
    // server (idempotent, no-op if already seen) so the coach gets a
    // read-receipt without forcing the member through the inbox.
    if (!fb.seen_by_member_at) {
      LtApi.markCoachFeedbackSeen(fb.id).catch(() => {});
      todayLog.update(curr => {
        if (!curr?.feedback) return curr;
        return {
          ...curr,
          feedback: curr.feedback.map(f =>
            f.id === fb.id ? { ...f, seen_by_member_at: new Date().toISOString() } : f
          ),
        };
      });
      loadUnreadFeedback();
    }
  }

  let replySavedFlash = null;
  async function saveReply(fbId) {
    if (replySaving) return;
    replySaving = fbId;
    const text = (replyDrafts[fbId] || '').trim();
    try {
      await LtApi.replyToCoachFeedback(fbId, text);
      // Optimistically patch the local feedback list — saves a round-trip.
      todayLog.update(curr => {
        if (!curr?.feedback) return curr;
        return {
          ...curr,
          feedback: curr.feedback.map(f =>
            f.id === fbId
              ? { ...f, member_reply: text || null, member_replied_at: text ? new Date().toISOString() : null }
              : f
          ),
        };
      });
      // Brief checkmark flash before closing the editor, so the save reads
      // as a confirmed action visually (not just a toast).
      replySavedFlash = fbId;
      setTimeout(() => {
        if (replySavedFlash === fbId) replySavedFlash = null;
        if (replyOpenId === fbId) replyOpenId = null;
      }, 600);
    } catch(e) { showError(e.message || $_('diary_extra.toast.reply_failed')); }
    replySaving = null;
  }

  // Svelte action — focuses the element when it mounts. Used on the
  // reply textarea so the member can start typing immediately after
  // tapping Reply (saves a redundant tap on the field itself).
  function autofocus(node) {
    setTimeout(() => node.focus(), 0);
    return {};
  }

  async function deleteReply(fbId) {
    if (!await confirmDialog({
      title: $_('diary.confirm.delete_reply_title'),
      message: $_('diary.confirm.delete_reply_msg'),
      confirmText: $_('common.delete'),
      dangerous: true,
    })) return;
    replyDrafts[fbId] = '';
    await saveReply(fbId);
  }

  // Inbox state — full list of feedback (lazy loaded when user opens the
  // inbox) + the set of dates with unread feedback (pulled cheaply on mount
  // so the badge + calendar dots render without parsing the whole list).
  let unreadFeedbackDates = new Set();
  let unreadFeedbackCount = 0;
  async function loadUnreadFeedback() {
    try {
      const dates = await LtApi.getUnreadCoachFeedbackDates();
      unreadFeedbackDates = new Set(dates || []);
      unreadFeedbackCount = (dates || []).length;
    } catch { unreadFeedbackDates = new Set(); unreadFeedbackCount = 0; }
  }

  let showCoachInbox = false;
  let inboxRows = [];
  let inboxLoading = false;
  async function openCoachInbox() {
    showCoachInbox = true;
    inboxLoading = true;
    try { inboxRows = await LtApi.getCoachFeedbackInbox(); }
    catch { inboxRows = []; }
    inboxLoading = false;
  }
  function relInboxTime(t) {
    if (!t) return '';
    const then = new Date(t).getTime();
    const diff = Date.now() - then;
    const mins = Math.round(diff / 60000);
    if (mins < 60) return mins <= 1 ? 'just now' : `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.round(hrs / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(t).toLocaleDateString();
  }
  async function inboxOpenDate(row) {
    showCoachInbox = false;
    // Explicit user action — mark this specific row seen on the server,
    // then refresh the unread tally so the badge / calendar dots update.
    try { await LtApi.markCoachFeedbackSeen(row.id); } catch {}
    if (row.workout_date && row.workout_date !== $currentDate) {
      await loadWorkout(row.workout_date);
      notes = $todayLog?.notes || '';
      await loadCoachFeedback(row.workout_date);
    } else {
      await loadCoachFeedback(row.workout_date || $currentDate);
    }
    loadUnreadFeedback();
  }

  async function markAllInboxSeen() {
    try { await LtApi.markCoachFeedbackSeen(); } catch {}
    inboxRows = inboxRows.map(r => ({ ...r, seen_by_member_at: r.seen_by_member_at || new Date().toISOString() }));
    loadUnreadFeedback();
  }

  async function startSuggestedPrescription(px) {
    let exs;
    if (px.template_id) {
      try {
        const tpl = await LtApi.getTemplate(px.template_id);
        exs = tpl.exercises || [];
      } catch { showError($_('diary_extra.toast.cant_load_template')); return; }
    } else if (Array.isArray(px.exercises)) {
      exs = px.exercises;
    } else {
      showError($_('diary_extra.toast.no_exercises')); return;
    }
    await loadTemplate({
      exercises: exs,
      name: px.template_name || px.name || 'Coach pick',
      id: px.template_id || null,
    }, 'diary.confirm.replace_suggested_msg');
  }

  onMount(async () => {
    // {#key $location} re-mounts this route on every nav. Re-fetching
    // when the store already holds the target date causes a visible flash
    // on the meal cards. Skip the refetch if the store is already on the
    // right date.
    const targetDate = localDateStr();
    if ($currentDate !== targetDate || !$todayLog) {
      await loadWorkout(targetDate);
    } else {
      currentDate.set(targetDate);
    }
    notes = $todayLog?.notes || '';
    loading = false;
    loadActiveProgram();
    loadSuggestedPrescriptions();
    loadCoachFeedback($currentDate);
    loadUnreadFeedback();

    // Deep-link: ExerciseDetail's "Log this today" stashes the exercise
    // payload here before push('/'). Pick it up and add as the next
    // exercise in today's workout, then clear the hint.
    try {
      const raw = sessionStorage.getItem('lt:diary-add-exercise');
      if (raw) {
        sessionStorage.removeItem('lt:diary-add-exercise');
        const ex = JSON.parse(raw);
        if (ex?.id) {
          // Defer so the rest of onMount's state settles first.
          setTimeout(() => addExercise(ex), 0);
        }
      }
    } catch {}
    // Streak + calendar dot indicators rely on the workout-dates set.
    // Loading it on mount instead of only when the picker opens means
    // the streak chip is live the whole time the diary is open.
    loadWorkoutDates();
    // Cache per-exercise previous bests for inline PR detection.
    loadPrevBests();

    // Auto-enable wake lock if setting is on
    if ($screenKeepAwake) {
      enableWakeLock();
    }

    document.addEventListener('visibilitychange', handleVisibility);
    _startDayTick();

    // Native server mode: loadWorkout reads local SQLite first, so a fresh
    // post-connect mount can see an empty cache before the differential
    // sync finishes pulling workouts down. Refresh after each sync-complete
    // event so the diary populates without requiring force-stop + reopen.
    // Also covers cross-device live updates while user is on the diary.
    if (isNative && getServerUrl()) {
      window.addEventListener('lt:sync-complete', _onSyncComplete);
    }
  });

  // Pull-to-refresh: track touch deltas while at scrollY 0. Past a
  // threshold the user gets a brief loading indicator + a refresh
  // (workout + feedback + unread tally + streak/PR caches). Native-feel
  // gesture standard on every fitness app — Capacitor's WebView doesn't
  // ship one, so this is a minimal implementation that gets out of the
  // way when not in use. Disabled in landscape / when not at top of page.
  // Pull-to-refresh removed from this route — App.svelte now owns the
  // gesture globally (native server mode). Diary reloads its data via
  // the lt:sync-complete listener above so pull-to-refresh on this page
  // still gets today's workout + feedback + unread tally + historical
  // dates + PRs + suggestions refreshed, without the two-spinner overlap
  // that used to happen when both handlers fired.

  function _onSyncComplete() {
    // Rely on the App-level pull-to-refresh (App.svelte) to fire the sync
    // itself; this listener refreshes everything the Diary route reads
    // locally so a user who pulled while staying on Diary sees the new
    // state without navigating away and back. Previously Diary owned its
    // own route-scoped PTR — removed for family parity, since NT + CT
    // put PTR in App.svelte and having it in both places rendered two
    // spinners on top of each other.
    if ($currentDate) {
      loadWorkout($currentDate).then(() => loadCoachFeedback($currentDate));
    }
    loadUnreadFeedback();
    loadWorkoutDates();
    loadPrevBests();
    loadSuggestedPrescriptions();
  }

  onDestroy(() => {
    // Don't release wake lock here — it persists across routes via the global store.
    // Only disable if the user had auto-enable setting on (they can toggle manually too)
    document.removeEventListener('visibilitychange', handleVisibility);
    window.removeEventListener('lt:sync-complete', _onSyncComplete);
    _stopDayTick();
  });

  function handleVisibility() {
    if (!document.hidden) {
      _maybeRollDay();
      // Pull fresh coach feedback for the current date (and the unread
      // tally) so notes that landed while the app was backgrounded show
      // up immediately without a manual nav.
      if ($currentDate) loadCoachFeedback($currentDate);
      loadUnreadFeedback();
    }
  }

  // Day-rollover guard. If the calendar day has changed since the user
  // last interacted (overnight backgrounded session, app left open past
  // midnight, etc.) and they're viewing yesterday's today-row, snap them
  // to the new today. Skip if they've manually navigated away to a
  // historical date — only auto-roll when they were already on "today".
  let _knownToday = null;
  function _maybeRollDay() {
    const today = localDateStr();
    if (_knownToday && _knownToday !== today && $currentDate === _knownToday) {
      loadWorkout(today).then(() => {
        notes = $todayLog?.notes || '';
        loadCoachFeedback(today);
      });
    }
    _knownToday = today;
  }
  // Tick every 60s while the app is foregrounded so a long-running open
  // diary catches the day rollover (00:00) without needing a foreground
  // event. Cheap — just a date-string compare.
  let _dayTickHandle = null;
  function _startDayTick() {
    if (_dayTickHandle != null) return;
    _knownToday = localDateStr();
    _dayTickHandle = setInterval(_maybeRollDay, 60000);
  }
  function _stopDayTick() {
    if (_dayTickHandle != null) clearInterval(_dayTickHandle);
    _dayTickHandle = null;
  }

  function prevDay() {
    // Parse as local noon to avoid UTC/local timezone drift
    const d = new Date($currentDate + 'T12:00:00');
    d.setDate(d.getDate() - 1);
    const ds = localDateStr(d);
    loadWorkout(ds).then(() => { notes = $todayLog?.notes || ''; loadCoachFeedback(ds); });
  }
  function nextDay() {
    const d = new Date($currentDate + 'T12:00:00');
    d.setDate(d.getDate() + 1);
    const ds = localDateStr(d);
    loadWorkout(ds).then(() => { notes = $todayLog?.notes || ''; loadCoachFeedback(ds); });
  }
  function goToday() {
    if (!isToday) {
      const ds = localDateStr();
      loadWorkout(ds).then(() => { notes = $todayLog?.notes || ''; loadCoachFeedback(ds); });
    }
  }

  $: isToday = $currentDate === localDateStr();
  $: isFuture = $currentDate > localDateStr();

  function formatDateHeader(dateStr) {
    const d = new Date(dateStr + 'T12:00:00');
    const today = new Date(); today.setHours(12,0,0,0);
    const diff = Math.round((d - today) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === -1) return 'Yesterday';
    if (diff === 1) return 'Tomorrow';
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  }

  // ── Workout Actions ───────────────────────────────────────────────
  async function handleWorkoutAction(e) {
    const action = e.detail?.value;
    if (action === 'replace') {
      // No confirm here anymore — this only opens the template picker sheet,
      // it doesn't touch $todayLog. The real guard is inside loadTemplate()
      // itself, which fires reliably regardless of how the user got there
      // (this menu, a direct picker tap, "load most recent", etc.) instead
      // of only covering this one entry path.
      openLoadWorkout();
    } else if (action === 'clear') {
      await saveWorkout($currentDate, { ...($todayLog || {}), name: '', template_id: null, program_id: null, exercises: [], notes: '' });
      notes = '';
      showSuccess($_('diary.toast.workout_cleared'));
    } else if (action === 'copy_yesterday') {
      await copyFromYesterday();
    } else if (action === 'reset_timer') {
      resetTimer();
      await saveWorkout($currentDate, { ...($todayLog || {}), duration_min: 0 });
      showSuccess($_('diary.toast.timer_reset'));
    }
  }

  async function copyFromYesterday() {
    const d = new Date($currentDate + 'T12:00:00');
    d.setDate(d.getDate() - 1);
    const yesterdayStr = localDateStr(d);
    // Temporarily load yesterday to grab exercises
    const currentDateBackup = $currentDate;
    try {
      await loadWorkout(yesterdayStr);
      const yesterdayExercises = ($todayLog?.exercises || []).map(ex => ({
        ...ex,
        sets: (ex.sets || []).map(s => ({ ...s, completed: false, reps: 0, weight: s.weight || 0 })),
      }));
      const yesterdayName = $todayLog?.name || '';
      // Reload current date
      await loadWorkout(currentDateBackup);
      if (yesterdayExercises.length === 0) {
        showError($_('diary.errors.no_workout_yesterday'));
        return;
      }
      await saveWorkout(currentDateBackup, {
        ...($todayLog || {}),
        name: yesterdayName,
        exercises: yesterdayExercises,
      });
      notes = $todayLog?.notes || '';
      showSuccess($_('diary.toast.copied_yesterday'));
    } catch (e) {
      await loadWorkout(currentDateBackup);
      showError($_('diary.errors.copy_failed'));
    }
  }

  // ── Load Workout from Program ──────────────────────────────────────
  async function openLoadWorkout() {
    showLoadWorkout = true;
    loadingPrograms = true;
    try {
      programs = await LtApi.getPrograms();
      // Auto-expand the active program
      const active = programs.find(p => p.is_active);
      if (active) {
        selectedProgram = await LtApi.getProgram(active.id);
      }
    } catch(e) { showError(e.message); }
    loadingPrograms = false;
  }

  async function selectProgram(id) {
    try { selectedProgram = await LtApi.getProgram(id); }
    catch(e) { showError(e.message); }
  }

  // Repeat/regress the current plan week (issue #13). Pass null to clear the
  // manual pin and return to auto-advance. Re-fetches so current_week and the
  // week-aware prefill reflect the change immediately.
  async function setPlanWeek(week) {
    if (!selectedProgram) return;
    try {
      await LtApi.setProgramWeekCursor(selectedProgram.id, week);
      selectedProgram = await LtApi.getProgram(selectedProgram.id);
    } catch(e) { showError(e.message); }
  }

  // Advance the plan week. Past the final week a 'repeat' block loops back to
  // week 1 (the "step from Week 4 to Week 1" case); 'hold' can't advance past
  // the end so the button is disabled there.
  function advancePlanWeek() {
    const cur = selectedProgram.current_week || 1;
    const dur = selectedProgram.duration_weeks || 1;
    if (cur >= dur) {
      if (selectedProgram.on_complete === 'repeat') setPlanWeek(1);
    } else {
      setPlanWeek(cur + 1);
    }
  }

  // Effective prescription for a given 1-based plan week (issue #13).
  // Merges the exercise's weeks[wk-1] entry over its exercise-level defaults;
  // absent weeks[] / week / a missing weeks[wk-1] slot falls back to the flat
  // target_* base — matching WorkoutEditor's fieldFor and the design doc so
  // the same template resolves to identical targets in both views.
  function resolveWeek(ex, wk) {
    const base = {
      sets: ex.target_sets, reps: ex.target_reps, weight: ex.target_weight,
      tempo: ex.tempo, rest_sec: ex.rest_sec,
    };
    if (!wk || !ex.weeks?.length) return base;
    const w = ex.weeks[wk - 1];
    if (!w) return base;
    return {
      sets: w.sets ?? base.sets,
      reps: w.reps ?? base.reps,
      weight: w.weight ?? base.weight,
      tempo: w.tempo ?? base.tempo,
      rest_sec: w.rest_sec ?? base.rest_sec,
    };
  }

  async function loadTemplate(template, confirmMsgKey = 'diary.confirm.replace_template_msg') {
    // Loading a template replaces $todayLog's exercises wholesale — any
    // exercise from the currently-loaded workout that isn't in the new
    // template gets tombstoned (deleted) by the uuid-diff in
    // stores/workout.js's _mergeAndSave, with no way to undo it. This is
    // the one confirm choke-point every entry path (menu action, template
    // picker tap, template-info sheet, "load most recent", suggested/
    // prescribed workout) funnels through, so gating it here covers all
    // of them instead of each caller individually. Callers with a more
    // specific message (loadFromSuggested, loadFromPrescription) pass
    // confirmMsgKey instead of duplicating their own pre-check, which
    // would otherwise double-prompt now that this guard always runs.
    if (($todayLog?.exercises?.length || 0) > 0
        && !await confirmDialog({
          title: $_('diary.confirm.replace_workout_title'),
          message: $_(confirmMsgKey),
          confirmText: $_('diary.confirm.replace_confirm'),
          dangerous: true,
        })) return;
    showLoadWorkout = false;
    // Current plan week for a multi-week program — drives week-aware prefill.
    // Only meaningful when this template's program is the active one.
    const planWeek = selectedProgram?.is_active ? (selectedProgram?.current_week || null) : null;
    // Clone the template exercises, auto-filling from last session if enabled
    const templateExercises = await Promise.all((template.exercises || []).map(async ex => {
      const lastSets = await getLastSets(ex.exercise_id);
      // Resolve this week's prescription. When the exercise carries a weeks[]
      // matrix and we're inside the active program, the plan value wins over
      // last-session progressive-overload memory for the current week.
      const eff = resolveWeek(ex, planWeek);
      const planWins = !!(planWeek && ex.weeks?.length);
      let sets;
      if (ex.set_specs && ex.set_specs.length > 0) {
        // Per-set targets defined in template — use them as the target weight/reps
        sets = ex.set_specs.map((spec, i) => {
          const parsedWeight = parseFloat(spec.weight);
          const parsedReps = parseInt(spec.reps);
          const parsedRepsL = parseInt(spec.reps_l);
          const parsedRepsR = parseInt(spec.reps_r);
          const set = {
            weight: Number.isFinite(parsedWeight) ? parsedWeight : (lastSets?.[i]?.weight ?? 0),
            reps: Number.isFinite(parsedReps) ? parsedReps : (lastSets?.[i]?.reps ?? 0),
            completed: false,
            notes: '',
          };
          // Asymmetric supersets: template author can pin a set to a
          // specific round via spec.number. Falls back to position when
          // unset, matching the diary's display convention.
          if (spec.number != null) set.number = spec.number;
          // Warmup flag from template — SetRow filters warmups out of
          // volume / PR / superset-round gating automatically.
          if (spec.warmup) set.warmup = true;
          // RPE target from template — SetRow renders it in the RPE chip
          // when the trackRpe setting is on, editable by the lifter.
          if (spec.rpe != null) set.rpe = spec.rpe;
          // Unilateral L/R split target — SetRow detects isSplit from
          // the presence of reps_l/reps_r and renders the L/R inputs.
          if (Number.isFinite(parsedRepsL)) set.reps_l = parsedRepsL;
          if (Number.isFinite(parsedRepsR)) set.reps_r = parsedRepsR;
          return set;
        });
      } else {
        const numSets = eff.sets || 1;
        // This week's uniform target weight/reps — used as the base fallback
        // when there's no last-session history to pull from.
        const tplWeight = parseFloat(eff.weight);
        const tplReps = parseInt(eff.reps);
        const baseWeight = Number.isFinite(tplWeight) ? tplWeight : 0;
        const baseReps = Number.isFinite(tplReps) ? tplReps : 0;
        if (lastSets && !planWins) {
          // Prior session wins (progressive-overload memory), template values
          // fill any gaps beyond what the last session had. Inside a
          // periodized block (planWins) we skip this so the plan's prescribed
          // week isn't overwritten by last week's logged load.
          sets = Array.from({ length: numSets }, (_, i) => ({
            weight: lastSets[i]?.weight ?? lastSets[lastSets.length - 1]?.weight ?? baseWeight,
            reps: lastSets[i]?.reps ?? lastSets[lastSets.length - 1]?.reps ?? baseReps,
            completed: false,
            notes: '',
          }));
        } else {
          // No history, or plan wins — use this week's planned weight/reps.
          sets = Array.from({ length: numSets }, () => ({
            weight: baseWeight, reps: baseReps, completed: false, notes: '',
          }));
        }
      }
      // Surface the resolved week's tempo/rest onto the logged exercise so the
      // rest timer (and any display) can use the plan's per-exercise values.
      return { ...ex, tempo: eff.tempo, rest_sec: eff.rest_sec, sets };
    }));

    // Prepend warm-up ramp when the user has opted into auto-warm-ups and
    // this exercise has a usable working weight.
    const withWarmups = $autoGenerateWarmups
      ? templateExercises.map(ex => {
          const firstWorking = (ex.sets || []).find(s => !s.warmup);
          const w = parseFloat(firstWorking?.weight || ex.target_weight || 0) || 0;
          const warmups = generateWarmupSets(w, $weightUnit);
          if (warmups.length === 0) return ex;
          return { ...ex, sets: [...warmups, ...(ex.sets || [])] };
        })
      : templateExercises;

    await saveWorkout($currentDate, {
      ...($todayLog || {}),
      name: template.name,
      template_id: template.id,
      program_id: selectedProgram?.id || null,
      // Stamp the plan week this session was performed in (issue #13) so the
      // diary can label it and it stays accurate after the athlete advances.
      program_week: planWeek,
      program_duration_weeks: planWeek ? (selectedProgram?.duration_weeks || null) : null,
      exercises: withWarmups,
    });
    notes = '';
    showSuccess($_('diary_extra.toast.loaded_named', { values: { name: template.name } }));
  }

  // ── Load from prescription ─────────────────────────────────────────
  async function loadFromPrescription() {
    const px = $todayPrescription;
    if (!px) return;
    let exs;
    if (px.template_exercises) {
      try { exs = JSON.parse(px.template_exercises); } catch { exs = []; }
    } else if (Array.isArray(px.exercises)) {
      exs = px.exercises;
    } else {
      showError($_('diary_extra.toast.no_exercises')); return;
    }
    // Reuse the template-load code path via a synthetic template object
    const syntheticProgram = selectedProgram;
    selectedProgram = { id: px.program_id || null };
    try {
      await loadTemplate({
        exercises: exs,
        name: px.template_name || px.name || 'Prescribed workout',
        id: px.template_id || null,
      }, 'diary.confirm.replace_prescribed_msg');
    } finally {
      selectedProgram = syntheticProgram;
    }
  }

  // ── Recent workouts for quick-load ──────────────────────────────────
  let recentWorkouts = [];
  async function loadRecentWorkouts() {
    try {
      const res = await fetch('/api/workout/recent?limit=3', { credentials: 'include' });
      if (res.ok) recentWorkouts = (await res.json()).filter(w => w.exercises && JSON.parse(w.exercises || '[]').length > 0);
    } catch {}
  }
  $: if (!loading && exercises.length === 0) loadRecentWorkouts();
  // Also load once on mount so the desktop right-rail's Recent
  // Workouts card has data even during an active session (the
  // empty-state trigger above doesn't fire when exercises exist).
  onMount(loadRecentWorkouts);

  // Rail measurement + viewport-width tracking. Kept in its own
  // onMount/onDestroy pair so the whole port stays self-contained.
  onMount(() => {
    _syncWideViewport();
    requestAnimationFrame(() => requestAnimationFrame(_measureRail));
    try {
      _railResizeObs = new ResizeObserver(_measureRail);
      if (_diaryBodyEl) _railResizeObs.observe(_diaryBodyEl);
    } catch { /* ResizeObserver unavailable — one-shot measurement stands */ }
    const onResize = () => { _syncWideViewport(); _measureRail(); };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      try { _railResizeObs?.disconnect(); } catch { /* ignore */ }
    };
  });

  async function quickLoad(recent) {
    const exs = JSON.parse(recent.exercises || '[]');
    // Auto-fill from last session if enabled
    const filled = await Promise.all(exs.map(async ex => {
      const lastSets = await getLastSets(ex.exercise_id);
      const numSets = (ex.sets || []).length || ex.target_sets || 3;
      let sets;
      if (lastSets) {
        sets = Array.from({ length: numSets }, (_, i) => ({
          weight: lastSets[i]?.weight || lastSets[lastSets.length - 1]?.weight || 0,
          reps: lastSets[i]?.reps || lastSets[lastSets.length - 1]?.reps || 0,
          completed: false, notes: '',
        }));
      } else {
        sets = Array.from({ length: numSets }, () => ({ weight: 0, reps: 0, completed: false, notes: '' }));
      }
      return { ...ex, sets };
    }));
    await saveWorkout($currentDate, {
      ...($todayLog || {}),
      name: recent.name || '',
      template_id: recent.template_id || null,
      program_id: recent.program_id || null,
      exercises: filled,
    });
    showSuccess($_('diary_extra.toast.loaded_workout', { values: { name: recent.name || $_('diary_extra.toast.workout_fallback') } }));
  }

  // ── Exercise management ────────────────────────────────────────────
  async function getLastSets(exerciseId) {
    if (!$autoFillLastWeights || !exerciseId) return null;
    try {
      const history = await LtApi.getWorkoutHistory(exerciseId);
      if (history.length > 0) {
        const lastSets = (history[0].sets || []).filter(s => s.completed);
        if (lastSets.length > 0) return lastSets;
      }
    } catch {}
    return null;
  }

  let pickerTargetSupersetId = null;
  let replacingIdx = null;

  let infoSheetOpen = false;
  let infoSheetExerciseId = null;
  let infoSheetExerciseName = null;
  let infoSheetIdx = -1;
  function openInfoSheet(idx) {
    const ex = exercises[idx];
    if (!ex) return;
    infoSheetIdx = idx;
    infoSheetExerciseId = ex.exercise_id || null;
    infoSheetExerciseName = ex.exercise_id ? null : (ex.exercise_name || null);
    infoSheetOpen = true;
  }
  function handleInfoReplace() {
    if (infoSheetIdx < 0) return;
    replacingIdx = infoSheetIdx;
    showPicker = true;
  }

  async function addExercise(ex) {
    // Replace mode (identity swap) and add-to-existing-superset mode both
    // close the picker because each resolves a specific user intent.
    // The plain "add to today" flow keeps the picker open so the user can
    // chain multiple adds without having to reopen + re-apply filters.
    if (replacingIdx != null || pickerTargetSupersetId != null) {
      showPicker = false;
    }

    // Replace mode: swap the exercise's identity in-place, keep sets/reps/weight/notes
    if (replacingIdx != null) {
      const idx = replacingIdx;
      replacingIdx = null;
      const updated = [...exercises];
      updated[idx] = {
        ...updated[idx],
        exercise_id: ex.id,
        exercise_name: ex.name,
      };
      await saveWorkout($currentDate, { ...($todayLog || {}), exercises: updated });
      showSuccess($_('diary_extra.toast.replaced_with', { values: { name: ex.name } }));
      return;
    }

    const lastSets = await getLastSets(ex.id);
    let sets, targetSets, targetReps, targetWeight;

    if (lastSets) {
      sets = lastSets.map(s => ({ reps: s.reps || 0, weight: s.weight || 0, completed: false }));
      targetSets = lastSets.length;
      targetReps = String(lastSets[0]?.reps || 10);
      targetWeight = String(lastSets[0]?.weight || '');
    } else {
      sets = [{ reps: 0, weight: 0, completed: false }];
      targetSets = 3;
      targetReps = '10';
      targetWeight = '';
    }

    // Pre-fill load_type from the user's saved preference for this
    // exercise (set via the chip's "Remember for this exercise" toggle).
    // Falls back to bilateral when no preference exists.
    const savedLoadType = ex.id != null && $exerciseLoadTypes
      ? $exerciseLoadTypes[ex.id] : null;
    const newExercise = {
      exercise_id: ex.id,
      exercise_name: ex.name,
      target_sets: targetSets,
      target_reps: targetReps,
      target_weight: targetWeight,
      notes: '',
      sets,
      ...(savedLoadType && savedLoadType !== 'bilateral' ? { load_type: savedLoadType } : {}),
    };

    let updated;
    if (pickerTargetSupersetId) {
      // Insert after the last exercise in the superset, with the same supersetId
      newExercise.superset_id = pickerTargetSupersetId;
      let insertAt = exercises.length;
      for (let i = exercises.length - 1; i >= 0; i--) {
        if (exercises[i].superset_id === pickerTargetSupersetId) { insertAt = i + 1; break; }
      }
      updated = [...exercises.slice(0, insertAt), newExercise, ...exercises.slice(insertAt)];
      pickerTargetSupersetId = null;
    } else {
      updated = [...exercises, newExercise];
    }
    await saveWorkout($currentDate, { ...($todayLog || {}), exercises: updated });
  }

  function openSupersetPicker(supersetId) {
    pickerTargetSupersetId = supersetId;
    showPicker = true;
  }

  // Rest-timer gating: fire when the just-completed set closes a "round".
  // - Standalone exercise: always fires.
  // - Superset: only when every exercise in the group now has the SAME number
  //   of completed sets (i.e., the round is closed). Partial rounds stay quiet.
  function _shouldStartRest(idx, newEx) {
    const ssId = newEx.superset_id;
    if (ssId == null || !(newEx.superset_size > 1)) return true;
    const group = exercises.map((e, i) => i === idx ? newEx : e)
                           .filter(e => e.superset_id === ssId);
    if (group.length < 2) return true;

    // Number-aware round gate (asymmetric supersets — addon sets, drop sets,
    // partial pairings). Each set carries an optional `number` override; if
    // unset, the number defaults to its index+1 (working-set position only,
    // warm-ups ignored). Round N is "done" when every exercise that has a
    // working set numbered N has it marked complete.
    //
    // What round did we just finish? The numbered position of the set the
    // user just toggled — the highest completed working set in newEx.
    const newSetsNumbered = _numberedWorkingSets(newEx);
    if (!newSetsNumbered.length) return false;
    const justCompleted = [...newSetsNumbered].reverse().find(s => s.completed);
    if (!justCompleted) return false;
    const round = justCompleted.number;

    // Round N is done when every exercise in the group that HAS a set
    // numbered N has that set completed. Exercises without a set numbered N
    // (the addon pattern — they only participate in some rounds) are skipped.
    return group.every(e => {
      const inRound = _numberedWorkingSets(e).filter(s => s.number === round);
      return inRound.length === 0 || inRound.every(s => s.completed);
    });
  }

  function _numberedWorkingSets(ex) {
    let auto = 0;
    return (ex.sets || []).filter(s => !s.warmup).map(s => {
      auto += 1;
      return { ...s, number: s.number != null ? s.number : auto };
    });
  }

  async function updateExercise(idx, ex) {
    const old = exercises[idx];
    let setJustCompleted = false;

    if (old && ex.sets && old.sets) {
      // Only WORKING sets trigger post-set logic (rest timer, PR check,
      // celebration). Warm-ups completing is noise — no rest, no PR.
      const oldCompleted = old.sets.filter(s => s.completed && !s.warmup).length;
      const newCompleted = ex.sets.filter(s => s.completed && !s.warmup).length;
      if (newCompleted > oldCompleted) {
        setJustCompleted = true;

        // Rest timer — supersets only rest after the whole round finishes
        // (i.e., every exercise in the group has one more completed set).
        // Between A1 → A2 in the same round, we stay silent.
        if ($restTimerEnabled && $restAutoStart && _shouldStartRest(idx, ex)) {
          // "Next up" after rest:
          //   - Standalone exercise: same exercise (next set of it)
          //   - Superset: the FIRST exercise in the group (start of round N+1)
          //     not the last one completed. "Finished A2, next up is A1 again."
          let nextEx = ex;
          if (ex.superset_id != null && ex.superset_size > 1) {
            const updatedExercises = exercises.map((e, i) => i === idx ? ex : e);
            const firstInGroup = updatedExercises.find(e => e.superset_id === ex.superset_id);
            if (firstInGroup) nextEx = firstInGroup;
          }
          startRestTimer({
            exerciseId:   nextEx.exercise_id || null,
            exerciseName: nextEx.exercise_name || '',
            // A plan's per-exercise rest (issue #13) overrides the global
            // default when present; otherwise fall back to the user's setting.
            durationSec:  Number(nextEx.rest_sec) > 0 ? Number(nextEx.rest_sec) : $restDuration,
          });
        }

        // PR check — compare to PRIOR workouts only (not today), skip
        // celebrations when planning ahead (future date)
        const justCompletedSet = ex.sets.find((s, i) => s.completed && (!old.sets[i] || !old.sets[i].completed));
        if (!isFuture && justCompletedSet && justCompletedSet.weight > 0 && ex.exercise_id) {
          try {
            const history = await LtApi.getWorkoutHistory(ex.exercise_id);
            // Collect prior completed sets, EXCLUDING today — otherwise your
            // first set becomes the baseline and later sets never beat it.
            let priorMax = 0;
            let priorE1rm = 0;
            let priorSetCount = 0;
            for (const h of history) {
              if (h.date === $currentDate) continue;
              for (const s of h.sets || []) {
                if (s.completed && s.weight > 0) {
                  priorSetCount++;
                  if (s.weight > priorMax) priorMax = s.weight;
                  const e1 = calc1RM(s.weight, s.reps);
                  if (e1 > priorE1rm) priorE1rm = e1;
                }
              }
            }
            // Only celebrate if there's a baseline (≥1 prior workout) AND
            // the new lift beats it
            if (priorSetCount > 0) {
              const newE1rm = calc1RM(justCompletedSet.weight, justCompletedSet.reps);
              const isWeightPR = justCompletedSet.weight > priorMax;
              const isE1rmPR = newE1rm > priorE1rm;
              if (isWeightPR || isE1rmPR) {
                celebratePR(
                  ex.exercise_name,
                  justCompletedSet.weight,
                  $weightUnit,
                  justCompletedSet.reps,
                  isWeightPR ? 'weight' : 'e1rm',
                );
              }
            }
          } catch {}
        }
      }
    }

    const updated = [...exercises];
    updated[idx] = ex;
    await saveWorkout($currentDate, { ...($todayLog || {}), exercises: updated });

    // Workout completion check — skip when planning ahead
    if (setJustCompleted && !isFuture) {
      const allDone = updated.every(e =>
        (e.sets || []).length > 0 && (e.sets || []).every(s => s.completed)
      );
      if (allDone && updated.length > 0) {
        await finishWorkout({ auto: true });
      }
    }
  }

  /** Explicit end-of-session: pause timer, record duration, mark completed,
   *  celebrate, show summary. Also used by the auto-complete path. */
  async function finishWorkout({ auto = false } = {}) {
    if (isFuture) return;
    // Re-opening an already-completed workout (manual tap on "View
    // workout summary", or an auto-fire after toggling a set off+on on
    // a prior session) must NOT re-run the celebrate / save / timer
    // reset path. The daily dedup in celebrateWorkoutComplete resets
    // at midnight, so without this guard, viewing yesterday's summary
    // today would fire a fresh local + push notification. resetTimer()
    // would also nuke today's running timer if viewing a past day.
    const wasAlreadyCompleted = !!$todayLog?.completed;
    if (wasAlreadyCompleted) {
      if (!auto) showSummary = true;
      return;
    }
    // Pause timer + persist elapsed
    let finalDuration = $todayLog?.duration_min || 0;
    if ($timerState && $timerState.date === $currentDate) {
      if (!$timerState.paused) pauseTimer();
      finalDuration = Math.round($timerMs / 60000 * 10) / 10;
    }
    await saveWorkout($currentDate, {
      ...($todayLog || {}),
      duration_min: finalDuration,
      completed: 1,
    });
    // Workout's done — clear the running timer so the pill disappears
    // instead of staying around offering a misleading "Resume". Final
    // elapsed has already been captured into duration_min above.
    resetTimer();
    // Kill any rest still counting down.
    stopRest(false);
    celebrateWorkoutComplete(workoutName);
    // Push the completed workout's estimated calories to NutriTrace if the
    // user has federation set up + calorie estimation on. Fire-and-forget
    // — failures show a soft toast but don't block the summary. The
    // external_id is the natural per-user-per-date key (LT has UNIQUE
    // (user_id, date) on workout_log, so one workout per day), which lets
    // NT idempotently update when the user amends a workout afterwards.
    if ($ntFederationEnabled && $caloriesBurnedEnabled) {
      _pushWorkoutToNutriTrace({ finalDuration }).catch(() => {});
    }
    if (auto) {
      if ($showCompletionSummary) showSummary = true;
    } else {
      // Manual finish always shows the summary so the user gets closure
      showSummary = true;
    }
  }

  // User edited the duration on the WorkoutSummary card after-the-fact.
  // Persist the new value, and if federation is enabled, re-push to
  // NutriTrace — the external_id is deterministic per (user, date) so
  // the previous row gets updated in place rather than duplicated.
  async function handleSummaryDurationChange(newMin) {
    if (!$todayLog || !Number.isFinite(newMin) || newMin <= 0) return;
    const updated = { ...$todayLog, duration_min: newMin };
    await saveWorkout($currentDate, updated);
    if ($ntFederationEnabled && $caloriesBurnedEnabled) {
      _pushWorkoutToNutriTrace({ finalDuration: newMin }).catch(() => {});
    }
  }

  async function _pushWorkoutToNutriTrace({ finalDuration }) {
    const dob = $currentUser?.birthday || null;
    const sex = $currentUser?.gender || null;
    const age = ageFromDob(dob);
    const kcal = estimateWorkoutCalories(
      { ...($todayLog || {}), exercises, duration_min: finalDuration },
      { weight_kg: $currentWeightKg, height_cm: $heightCm, age, sex },
    );
    if (!Number.isFinite(kcal) || kcal <= 0) return;
    try {
      const res = await fetch('/api/nt/log-workout', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: $currentDate,
          name: workoutName,
          duration_min: finalDuration,
          calories_burned: kcal,
          external_id: `lt:workout:${$currentDate}`,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        showError(body?.error || $_('diary_extra.toast.nt_sync_failed', { values: { status: res.status } }));
      }
    } catch (e) {
      showError($_('diary_extra.toast.cant_reach_nt', { values: { error: e?.message || $_('diary_extra.toast.network_error') } }));
    }
  }

  async function removeExercise(idx) {
    if ($confirmExerciseRemoval) {
      const name = exercises[idx]?.exercise_name || 'this exercise';
      if (!await confirmDialog({
        title: $_('diary.confirm.remove_exercise_title'),
        message: $_('diary.confirm.remove_exercise_msg', { values: { name } }),
        confirmText: $_('diary.confirm.remove_confirm'),
        dangerous: true,
      })) return;
    }
    const updated = exercises.filter((_, i) => i !== idx);
    await saveWorkout($currentDate, { ...($todayLog || {}), exercises: updated });
  }

  async function moveExercise(idx, dir) {
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= exercises.length) return;
    const updated = [...exercises];
    [updated[idx], updated[newIdx]] = [updated[newIdx], updated[idx]];
    await saveWorkout($currentDate, { ...($todayLog || {}), exercises: updated });
  }

  async function moveWithinSuperset({ supersetId, fromIdx, toIdx }) {
    const groupIdxs = [];
    exercises.forEach((ex, i) => { if (ex.superset_id === supersetId) groupIdxs.push(i); });
    if (toIdx < 0 || toIdx >= groupIdxs.length) return;
    const updated = [...exercises];
    const a = groupIdxs[fromIdx], b = groupIdxs[toIdx];
    [updated[a], updated[b]] = [updated[b], updated[a]];
    await saveWorkout($currentDate, { ...($todayLog || {}), exercises: updated });
  }

  // ── Drag-to-reorder (group level — supersets move as a unit) ─────────
  let draggedGroupIdx = -1;
  let dragOverIdx = -1;

  // ── Draggable + FAB ───────────────────────────────────────────────────────
  // Users can drag it anywhere on screen so it doesn't collide with other
  // floating elements (Trace FAB, rest timer, workout-mode pill, etc.).
  // Position persists to localStorage, re-clamped to viewport on resize.
  let addFabPos = (() => {
    try {
      const pos = JSON.parse(localStorage.getItem('lt:addFabPos') || 'null');
      if (!pos) return null;
      pos.x = Math.max(8, Math.min(window.innerWidth  - 64, pos.x));
      pos.y = Math.max(8, Math.min(window.innerHeight - 64, pos.y));
      return pos;
    } catch { return null; }
  })();
  function _clampAddFab() {
    if (!addFabPos) return;
    addFabPos = {
      x: Math.max(8, Math.min(window.innerWidth  - 64, addFabPos.x)),
      y: Math.max(8, Math.min(window.innerHeight - 64, addFabPos.y)),
    };
  }
  if (typeof window !== 'undefined') window.addEventListener('resize', _clampAddFab);
  let addFabHasDragged = false;

  $: addFabStyle = addFabPos
    ? `left:${addFabPos.x}px; top:${addFabPos.y}px; right:auto; bottom:auto;`
    : '';

  function startAddFabDrag(e) {
    addFabHasDragged = false;
    const startX = e.clientX;
    const startY = e.clientY;
    const baseX = addFabPos ? addFabPos.x : window.innerWidth  - 72;
    const baseY = addFabPos ? addFabPos.y : window.innerHeight - (56 + 56 + 32); // rough default
    function move(ev) {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!addFabHasDragged && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) addFabHasDragged = true;
      if (!addFabHasDragged) return;
      addFabPos = {
        x: Math.max(8, Math.min(window.innerWidth  - 64, baseX + dx)),
        y: Math.max(8, Math.min(window.innerHeight - 64, baseY + dy)),
      };
    }
    function up() {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (addFabHasDragged) localStorage.setItem('lt:addFabPos', JSON.stringify(addFabPos));
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }
  function handleAddFabClick() {
    if (addFabHasDragged) return;   // suppress click after drag
    showPicker = true;
  }

  // ── Edge-scroll during drag ──────────────────────────────────────────────
  // When a drag is in progress and the pointer gets within EDGE_ZONE of
  // the viewport's top/bottom edge, auto-scroll the page in that direction.
  // Speed ramps up the deeper the pointer is into the edge zone.
  //
  // We listen at the DOCUMENT level (not on each drop target) so the
  // scroll kicks in even when the pointer is over page chrome, empty
  // whitespace, or anywhere else with no group div underneath — which
  // was the "it barely works" bug before.
  let _dragScrollRaf = null;
  let _dragScrollVelocity = 0;
  const EDGE_ZONE = 110;    // px from edge where auto-scroll kicks in
  const MAX_SPEED = 26;     // px per frame at max (≈1560 px/s on 60Hz)

  function _dragScrollTick() {
    if (_dragScrollVelocity === 0) { _dragScrollRaf = null; return; }
    // behavior: 'instant' bypasses the global `html { scroll-behavior: smooth }`
    // — otherwise each 26px call gets animated over ~300ms and stacked calls
    // crawl at snails pace on mobile.
    window.scrollBy({ top: _dragScrollVelocity, left: 0, behavior: 'instant' });
    _dragScrollRaf = requestAnimationFrame(_dragScrollTick);
  }
  function _updateDragScroll(clientY) {
    const vh = window.innerHeight;
    let v = 0;
    if (clientY < EDGE_ZONE) {
      const depth = Math.max(0, Math.min(1, 1 - clientY / EDGE_ZONE));
      v = -Math.ceil(depth * MAX_SPEED);
    } else if (clientY > vh - EDGE_ZONE) {
      const depth = Math.max(0, Math.min(1, 1 - (vh - clientY) / EDGE_ZONE));
      v = Math.ceil(depth * MAX_SPEED);
    }
    _dragScrollVelocity = v;
    if (v !== 0 && _dragScrollRaf == null) _dragScrollRaf = requestAnimationFrame(_dragScrollTick);
  }
  function _stopDragScroll() {
    _dragScrollVelocity = 0;
    if (_dragScrollRaf) { cancelAnimationFrame(_dragScrollRaf); _dragScrollRaf = null; }
  }

  // Document-level drag listeners. Attached on dragstart, removed on
  // dragend. They handle the edge-scroll independently of whichever
  // element the pointer is over.
  function _onDocDrag(e) {
    // Some browsers report clientY = 0 on the final drag/dragend event —
    // ignore those to avoid a bogus scroll up.
    if (e.clientY === 0 && e.clientX === 0) return;
    _updateDragScroll(e.clientY);
  }

  function onGroupDragStart(e, gIdx) {
    draggedGroupIdx = gIdx;
    try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(gIdx)); } catch {}
    document.addEventListener('drag',     _onDocDrag);
    document.addEventListener('dragover', _onDocDrag);
  }
  function onGroupDragOver(e, gIdx) {
    if (draggedGroupIdx < 0 || draggedGroupIdx === gIdx) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'move'; } catch {}
    dragOverIdx = gIdx;
  }
  function onGroupDragEnd() {
    draggedGroupIdx = -1; dragOverIdx = -1;
    _stopDragScroll();
    document.removeEventListener('drag',     _onDocDrag);
    document.removeEventListener('dragover', _onDocDrag);
  }
  async function onGroupDrop(e, gIdx) {
    e.preventDefault();
    _stopDragScroll();
    document.removeEventListener('drag',     _onDocDrag);
    document.removeEventListener('dragover', _onDocDrag);
    const from = draggedGroupIdx;
    draggedGroupIdx = -1; dragOverIdx = -1;
    if (from < 0 || from === gIdx) return;
    const groups = [...supersetGroups];
    const [moved] = groups.splice(from, 1);
    groups.splice(gIdx, 0, moved);
    const flat = groups.flatMap(g => g.exercises);
    await saveWorkout($currentDate, { ...($todayLog || {}), exercises: flat });
  }

  async function removeSuperset(supersetId) {
    if ($confirmExerciseRemoval) {
      const names = exercises
        .filter(ex => String(ex.superset_id) === String(supersetId))
        .map(ex => ex.exercise_name)
        .filter(Boolean);
      const list = names.length ? names.join(', ') : 'All exercises in this superset';
      if (!await confirmDialog({
        title: $_('diary.confirm.remove_superset_title'),
        message: $_('diary.confirm.remove_superset_msg', { values: { list } }),
        confirmText: $_('diary.confirm.remove_confirm'),
        dangerous: true,
      })) return;
    }
    const updated = exercises.filter(ex => String(ex.superset_id) !== String(supersetId));
    await saveWorkout($currentDate, { ...($todayLog || {}), exercises: updated });
    showSuccess($_('diary.toast.superset_removed'));
  }

  // ── Superset management ─────────────────────────────────────────────
  $: existingSupersets = (() => {
    const map = new Map();
    for (const ex of exercises) {
      if (ex.superset_id != null && ex.superset_size > 1) {
        if (!map.has(ex.superset_id)) map.set(ex.superset_id, []);
        map.get(ex.superset_id).push(ex.exercise_name);
      }
    }
    return [...map.entries()].map(([id, names]) => ({ id, names }));
  })();

  function newSsId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function _recalcSuperset(arr, ssId) {
    const members = arr.filter(e => e.superset_id === ssId);
    if (members.length < 2) {
      for (const m of members) {
        m.superset_id = undefined;
        m.superset_size = undefined;
        m.superset_position = undefined;
      }
    } else {
      for (let i = 0; i < members.length; i++) {
        members[i].superset_size = members.length;
        members[i].superset_position = i;
      }
    }
    return arr;
  }

  async function createSupersetFrom(indices) {
    if (indices.length < 2) return;
    const ssId = newSsId();
    const arr = [...exercises];
    const sorted = [...indices].sort((a, b) => b - a);
    const extracted = sorted.map(i => arr.splice(i, 1)[0]);
    extracted.reverse();
    for (let i = 0; i < extracted.length; i++) {
      extracted[i].superset_id = ssId;
      extracted[i].superset_size = extracted.length;
      extracted[i].superset_position = i;
    }
    const insertAt = Math.min(...indices.map(i => Math.min(i, arr.length)));
    arr.splice(insertAt, 0, ...extracted);
    await saveWorkout($currentDate, { ...($todayLog || {}), exercises: arr });
    showSuccess($_('diary.toast.superset_created'));
  }

  async function joinSuperset(idx, targetSsId) {
    const arr = [...exercises];
    const ex = arr.splice(idx, 1)[0];
    let insertAt = -1;
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i].superset_id === targetSsId) { insertAt = i + 1; break; }
    }
    if (insertAt < 0) insertAt = arr.length;
    ex.superset_id = targetSsId;
    arr.splice(insertAt, 0, ex);
    _recalcSuperset(arr, targetSsId);
    await saveWorkout($currentDate, { ...($todayLog || {}), exercises: arr });
    showSuccess($_('diary.toast.added_to_superset'));
  }

  async function leaveSuperset(idx) {
    const arr = [...exercises];
    const ssId = arr[idx].superset_id;
    arr[idx] = { ...arr[idx], superset_id: undefined, superset_size: undefined, superset_position: undefined };
    if (ssId) _recalcSuperset(arr, ssId);
    await saveWorkout($currentDate, { ...($todayLog || {}), exercises: arr });
    showSuccess($_('diary.toast.removed_from_superset'));
  }

  // ── Exercise action sheet ───────────────────────────────────────────
  let exActionsOpen = false;
  let exActionsList = [];
  let exActionsIdx = -1;
  let exActionsTitle = '';

  // Superset picker sheets
  let joinPickerOpen = false;
  let newSsPickerOpen = false;
  let newSsPicks = [];

  function openExMenu(idx) {
    const ex = exercises[idx];
    if (!ex) return;
    const inSs = ex.superset_id != null && ex.superset_size > 1;
    exActionsIdx = idx;
    exActionsTitle = ex.exercise_name;
    const actions = [];
    actions.push({ label: 'Replace exercise', icon: 'swap_horiz', value: 'replace' });
    if (inSs) {
      actions.push({ label: 'Remove from superset', icon: 'link_off', value: 'leave_ss' });
    } else {
      if (existingSupersets.length > 0) {
        actions.push({ label: 'Add to existing superset', icon: 'link', value: 'join_ss' });
      }
      if (exercises.length >= 2) {
        actions.push({ label: 'Start new superset…', icon: 'add_link', value: 'new_ss' });
      }
    }
    exActionsList = actions;
    exActionsOpen = true;
  }

  function handleExAction(e) {
    const val = e.detail.value;
    const idx = exActionsIdx;
    exActionsOpen = false;
    switch (val) {
      case 'replace':
        replacingIdx = idx;
        showPicker = true;
        break;
      case 'leave_ss': leaveSuperset(idx); break;
      case 'join_ss': joinPickerOpen = true; break;
      case 'new_ss':
        newSsPicks = [];
        newSsPickerOpen = true;
        break;
    }
  }

  function handleJoinSs(ssId) {
    joinPickerOpen = false;
    joinSuperset(exActionsIdx, ssId);
  }

  function handleCreateSs() {
    if (newSsPicks.length === 0) return;
    newSsPickerOpen = false;
    createSupersetFrom([exActionsIdx, ...newSsPicks]);
    newSsPicks = [];
  }

  // ── Workout title (inline rename + auto-name) ─────────────────────
  function startEditName() {
    editNameValue = workoutName || suggestedWorkoutName();
    editingName = true;
  }
  async function commitName() {
    const next = editNameValue.trim();
    editingName = false;
    if (next === (workoutName || '')) return;
    await saveWorkout($currentDate, { ...($todayLog || {}), name: next });
  }
  function cancelEditName() { editingName = false; editNameValue = ''; }

  /** Derive a default workout name from primary muscle categories of the loaded exercises. */
  function suggestedWorkoutName() {
    if (!exercises.length) return '';
    const cats = new Set(exercises.map(e => (e.category || '').toLowerCase()).filter(Boolean));
    const has = (c) => cats.has(c);
    if (has('chest') && has('shoulders') && !has('back')) return 'Push Day';
    if (has('back') && (has('biceps') || has('arms')) && !has('chest')) return 'Pull Day';
    if (has('legs') || has('quadriceps') || has('hamstrings') || has('glutes')) {
      if (cats.size <= 2) return 'Leg Day';
    }
    if (has('arms') || (has('biceps') && has('triceps'))) return 'Arm Day';
    if (has('chest') && has('back')) return 'Upper Body';
    if (cats.size >= 4) return 'Full Body';
    // Fallback: cap-cased first category
    const first = [...cats][0];
    return first ? first.charAt(0).toUpperCase() + first.slice(1) + ' Day' : 'Workout';
  }

  /** Auto-name the workout on first exercise add if setting is on + name is empty. */
  let _autoNamedSignature = '';
  $: {
    const sig = `${$currentDate}|${exercises.length}`;
    if ($autoNameWorkouts && !workoutName && exercises.length > 0 && sig !== _autoNamedSignature) {
      _autoNamedSignature = sig;
      const suggested = suggestedWorkoutName();
      if (suggested) {
        saveWorkout($currentDate, { ...($todayLog || {}), name: suggested });
      }
    }
  }

  async function saveNotes() {
    await saveWorkout($currentDate, { ...($todayLog || {}), notes });
  }

  async function updateDuration(mins) {
    await saveWorkout($currentDate, { ...($todayLog || {}), duration_min: mins });
  }
</script>

<div class="page">
  <!-- Action icons — fixed at top-right, same level as hamburger (NutriTrace pattern).
       Mobile-only: hidden at ≥1280px because the desktop rail owns Gym Tools,
       Body Stats, and the More menu; see .diary-topbar-actions display:none rule. -->
  <div use:portal class="diary-topbar-actions">
    <button class="btn-icon accent" on:click={() => showGymTools = true} aria-label={$_('diary.actions.gym_tools')} title={$_('diary.actions.gym_tools_long')}>
      <span class="material-symbols-rounded">calculate</span>
    </button>
    <button class="btn-icon accent" on:click={() => showBodyStats = true} aria-label={$_('diary.actions.body_stats')} title={$_('diary.actions.body_stats_long')}>
      <span class="material-symbols-rounded">scale</span>
    </button>
    <button class="btn-icon accent" on:click={() => showWorkoutActions = true} aria-label={$_('diary.actions.workout_actions')} title={$_('diary.actions.workout_options')}>
      <span class="material-symbols-rounded">more_vert</span>
    </button>
  </div>


  <!-- Sticky-top container — keeps the page header AND the date sub-bar
       pinned together as a single block. Without this wrap, both were
       separately sticky with computed top offsets that drifted relative
       to one another as the header re-laid out. -->
  <div class="diary-sticky-top">
  <!-- Page header — same pattern as Exercises/Programs/Statistics/Settings -->
  <header class="page-header" class:banner-gradient={$bannerStyle === 'gradient'} class:banner-animated={$bannerStyle === 'animated'}>
    <h1>{$_('routes.diary.title')}</h1>
    <!-- Desktop-only Add-exercise header action — sits in the same
         header slot the Coach Feedback button uses so it reads with
         the app's canonical header-action styling. The mobile FAB
         (position:fixed bottom-right) is the primary affordance
         below 1280px; hidden here on narrow viewports so mobile
         users see one clear affordance, not two. -->
    {#if _wideViewport && exercises.length > 0}
      <button class="diary-header-action diary-header-add"
              on:click={handleAddFabClick}
              title="Add exercise" aria-label="Add exercise">
        <span class="material-symbols-rounded">add</span>
      </button>
    {/if}
    {#if $currentUser?.trainer_id || unreadFeedbackCount > 0 || inboxRows.length > 0}
      <button class="diary-header-action" class:dim={unreadFeedbackCount === 0}
              on:click={openCoachInbox}
              title="Coach Feedback" aria-label="Coach feedback">
        <span class="material-symbols-rounded">
          {unreadFeedbackCount > 0 ? 'mark_email_unread' : 'forum'}
        </span>
        {#if unreadFeedbackCount > 0}
          <span class="diary-header-badge">{unreadFeedbackCount}</span>
        {/if}
      </button>
    {/if}
  </header>

  <!-- Sticky date sub-bar — sits below the header inside the sticky-top
       container so the two move as one block instead of computing
       separate top offsets. -->
  <div class="date-nav">
    <button class="btn-icon accent" on:click={prevDay} aria-label={$_('diary.nav.previous_day')} title={$_('diary.nav.previous_day')}>
      <span class="material-symbols-rounded">chevron_left</span>
    </button>
    <button class="date-btn" on:click={openDatePicker} title={$_('diary.nav.jump_to_date')}>
      <span class="date-text">{formatDateHeader($currentDate)}</span>
      <span class="date-sub">{formatDateSub($currentDate)}</span>
    </button>
    {#if streakCount >= 2}
      <span class="streak-chip" title={`${streakCount}-day streak`}>
        🔥 {streakCount}
      </span>
    {/if}
    {#if !isToday}
      <button class="today-pill" on:click={goToday} title={$_('diary.nav.jump_to_today')}>
        <span class="material-symbols-rounded today-pill-icon">today</span>
        Today
      </button>
    {/if}
    <button class="btn-icon accent" on:click={nextDay} aria-label={$_('diary.nav.next_day')} title={$_('diary.nav.next_day')}>
      <span class="material-symbols-rounded">chevron_right</span>
    </button>
  </div>
  </div>

  <!-- (The redundant .workout-name-bar used to live here. The editable
       .workout-title below the summary row is the canonical rename spot.) -->

  <!-- Diary body — wraps every in-flow content block (excluding the
       sticky top-bar, FAB, and modal sheets). At >=1280px on non-forced-
       mobile viewports this becomes a three-column grid: left column
       hoists the .summary-bar and .now-strip (session HUD), center is
       the exercise list + banners + notes + cardio, right column is a
       program-context rail (Active program, Today's plan, Session stats).
       On mobile the wrapper is a plain block — DOM order stays intact,
       .diary-right-rail is display:none. Gated by
       html:not(.force-mobile-layout) so the desktop opt-out toggle
       still delivers the mobile flow at any width. -->
  <div class="diary-body" class:rail-hidden={_railMode === 'hidden'} bind:this={_diaryBodyEl}>

  <!-- Left column wrapper (desktop only via grid; mobile just stacks).
       Groups the session HUD (summary-bar + now-strip) into one grid
       cell so column heights are independent — otherwise grid shares
       row heights across all columns and the tall stacked summary-bar
       inflates row 1 in the center column, leaving a big gap between
       the workout title and the exercise list. -->
  <div class="diary-hud-col">
    <!-- Rail-style header (desktop only). Same "OVERVIEW" pattern
         the right rail uses so the two columns read as one system.
         Hidden on mobile via CSS since mobile inlines the summary
         bar without any header. -->
    <div class="hud-title">
      <span class="hud-title-text">Session</span>
    </div>
    <!-- Summary bar — single dense row (mobile) / vertical stack
         (desktop left column). Sets / exercises / volume / timer /
         wake-lock. -->
    {#if exercises.length > 0}
      <div class="summary-bar" class:done={stats.total > 0 && stats.completed === stats.total}>
        <div class="sb-fill" style:width={`${stats.total > 0 ? Math.round(stats.completed / stats.total * 100) : 0}%`}></div>
        <div class="stat">
          <span class="material-symbols-rounded stat-icon">check_circle</span>
          <span class="stat-val">{stats.completed}/{stats.total}</span>
          <span class="stat-label">{$_('diary_extra.sets')}</span>
        </div>
        <div class="stat">
          <span class="material-symbols-rounded stat-icon">fitness_center</span>
          <span class="stat-val">{exercises.length}</span>
          <span class="stat-label">{$_('diary_extra.exercises')}</span>
        </div>
        {#if totalVolume > 0}
          <div class="stat">
            <span class="material-symbols-rounded stat-icon">monitoring</span>
            <span class="stat-val">{totalVolume >= 1000 ? (totalVolume/1000).toFixed(1) + 'k' : Math.round(totalVolume)}</span>
            <span class="stat-label">{$weightUnit}</span>
          </div>
        {/if}
        {#if !$todayLog?.completed}
          <WorkoutTimer bind:minutes={durationMin} on:update={e => updateDuration(e.detail)} />
        {/if}
        <button class="wake-toggle" class:active={$screenOn} on:click={toggleWakeLock} title={$screenOn ? 'Screen lock on' : 'Screen lock off'}>
          <span class="material-symbols-rounded">
            {$screenOn ? 'stay_current_portrait' : 'screen_lock_portrait'}
          </span>
        </button>
      </div>
    {/if}
    <!-- "Now doing" pill — moved up from between workout-title-row and
         exercise-list so it stays adjacent to summary-bar in the left
         HUD column at wide widths (and appears right below session
         progress on mobile too, which reads at least as well). -->
    {#if currentStatus}
      <button class="now-strip" on:click={scrollToCurrent} title="Jump to this exercise">
        <span class="material-symbols-rounded now-icon">play_arrow</span>
        <div class="now-info">
          <span class="now-label">Now</span>
          <span class="now-exercise">{currentStatus.label}</span>
        </div>
        <span class="now-set">{currentStatus.setInfo}</span>
        <span class="material-symbols-rounded now-chev">chevron_right</span>
      </button>
    {/if}
    <!-- Desktop-only empty-state card. Renders when there's no
         active session so the left column reads intentional instead
         of blank. Hidden on mobile via CSS. -->
    {#if exercises.length === 0 && !loading && !isFuture}
      <div class="hud-empty-card">
        <span class="material-symbols-rounded hud-empty-icon">fitness_center</span>
        <p class="hud-empty-title">Nothing logged yet</p>
        <p class="hud-empty-desc">Load a workout from a program or add an exercise to get started.</p>
        <button type="button" class="rail-action" on:click={openLoadWorkout}>
          <span class="material-symbols-rounded">library_books</span>
          Load Workout
        </button>
      </div>
    {/if}
    <!-- Desktop-only Finish button. Duplicate of the .finish-btn
         that lives at the end of .exercise-list on mobile — sticky
         at the top of the HUD column so you don't have to scroll
         to the bottom of an 8-exercise session to end it. Uses the
         same finishWorkout({auto:false}) handler. Original hidden
         on desktop via CSS. Guard mirrors the original. -->
    {#if stats.completed > 0 && !isFuture}
      <button class="hud-finish-btn"
              class:reopen={$todayLog?.completed}
              on:click={() => finishWorkout({ auto: false })}>
        <span class="material-symbols-rounded">
          {$todayLog?.completed ? 'task_alt' : 'flag'}
        </span>
        <span class="hud-finish-text">
          {$todayLog?.completed ? 'View summary' : 'Finish workout'}
        </span>
        {#if !$todayLog?.completed}
          <span class="hud-finish-sub">{stats.completed}/{stats.total} sets</span>
        {/if}
      </button>
    {/if}
    <!-- Desktop-only session notes card. Duplicate of the
         .notes-card that lives inside .exercise-list on mobile —
         both bind to the same `notes` variable so state is shared
         and edits from either place stick. Original hidden on
         desktop via CSS to keep the notes single-source visually. -->
    {#if exercises.length > 0}
      <div class="hud-notes-card">
        <div class="hud-notes-head">
          <span class="material-symbols-rounded">edit_note</span>
          <span class="hud-notes-title">Session Notes</span>
        </div>
        <textarea
          class="hud-notes-input"
          placeholder={$_('diary_extra.notes_ph')}
          bind:value={notes}
          on:blur={saveNotes}
          rows="4"
        ></textarea>
      </div>
    {/if}
  </div>

  <!-- Center column wrapper. On mobile this is just a plain block; on
       desktop it becomes the single grid cell in column 2, so the
       content stacks by flex without its row heights being influenced
       by anything in the HUD or rail columns. -->
  <div class="diary-main-col">

  <!-- Planning badge when viewing a future date -->
  {#if isFuture}
    <div class="planning-badge">
      <span class="material-symbols-rounded">event_note</span>
      Planning ahead — this workout is scheduled for {formatDateHeader($currentDate)}
    </div>
  {/if}


  {#if $todayPrescription && ($todayPrescription.id || $todayPrescription.template_id || $todayPrescription.exercises)}
    {@const px = $todayPrescription}
    {@const alreadyLoaded = $todayLog?.template_id && $todayLog.template_id === px.template_id && ($todayLog?.exercises?.length > 0)}
    <div class="coach-banner" class:loaded={alreadyLoaded}>
      <span class="material-symbols-rounded coach-icon">supervisor_account</span>
      <div class="coach-body">
        <div class="coach-title">
          Coach {px.trainer_name || 'your trainer'} prescribed:
          <strong>{px.template_name || px.name || 'a workout'}</strong>
        </div>
        {#if px.notes}
          <div class="coach-notes">{px.notes}</div>
        {/if}
      </div>
      {#if alreadyLoaded}
        <span class="coach-loaded-chip">
          <span class="material-symbols-rounded" style="font-size:14px">check_circle</span>
          Loaded
        </span>
      {:else}
        <button class="btn btn-primary coach-btn" on:click={loadFromPrescription}>
          Load
        </button>
      {/if}
    </div>
  {/if}

  <!-- Coach feedback banner — workout-level note (exercise_idx NULL) left by
       the trainer for this workout. Includes inline reply UI. -->
  {#if $todayLog?.feedback && $todayLog.feedback.some(f => f.exercise_idx == null)}
    {#each $todayLog.feedback.filter(f => f.exercise_idx == null) as f (f.id)}
      <div class="coach-feedback-banner" in:fade={{ duration: 200 }}>
        <div class="avatar-chip coach">
          {#if f.trainer_avatar_url}
            <img src={resolveAssetUrl(f.trainer_avatar_url)} alt="" />
          {:else}
            {(f.trainer_name || 'C')[0].toUpperCase()}
          {/if}
        </div>
        <div class="coach-feedback-body">
          <div class="coach-feedback-head">
            <span>Coach {f.trainer_name || 'your trainer'}</span>
            {#if f.updated_at}<span class="coach-feedback-time">· {relInboxTime(f.updated_at)}</span>{/if}
          </div>
          <div class="coach-feedback-note">{f.note}</div>

          {#if replyOpenId === f.id}
            <div class="reply-edit">
              <textarea class="reply-input" rows="2"
                use:autofocus
                bind:value={replyDrafts[f.id]}
                placeholder={$_('diary_extra.reply_ph')}></textarea>
              <div class="reply-actions">
                {#if f.member_reply}
                  <button class="reply-link danger" on:click={() => deleteReply(f.id)}>{$_('diary_extra.delete')}</button>
                {/if}
                <button class="reply-link" on:click={() => replyOpenId = null}>{$_('diary_extra.cancel')}</button>
                <button class="reply-save" class:flashed={replySavedFlash === f.id}
                        on:click={() => saveReply(f.id)}
                        disabled={replySaving === f.id || !(replyDrafts[f.id] || '').trim()}>
                  {#if replySavedFlash === f.id}<span class="material-symbols-rounded" style="font-size:14px">check</span>{:else}{replySaving === f.id ? 'Saving…' : 'Reply'}{/if}
                </button>
              </div>
            </div>
          {:else if f.member_reply}
            <button class="my-reply" on:click={() => openReply(f)}>
              <span class="my-reply-label">
                You{#if f.member_replied_at} · {relInboxTime(f.member_replied_at)}{/if}
              </span>
              <span class="my-reply-text">{f.member_reply}</span>
              <span class="material-symbols-rounded my-reply-edit-icon">edit</span>
            </button>
          {:else}
            <button class="reply-add" on:click={() => openReply(f)}>
              <span class="material-symbols-rounded" style="font-size:14px">reply</span>
              Reply
            </button>
          {/if}
        </div>
      </div>
    {/each}
  {/if}

  {#if suggestedPrescriptions.length > 0 && exercises.length === 0 && !isFuture}
    <div class="suggested-section">
      <div class="suggested-head">
        <span class="material-symbols-rounded suggested-icon">recommend</span>
        Suggested by your coach
      </div>
      {#each suggestedPrescriptions as px (px.id)}
        <button class="suggested-row" on:click={() => startSuggestedPrescription(px)}>
          <div class="suggested-body">
            <span class="suggested-title">{px.template_name || px.name || 'Coach pick'}</span>
            <span class="suggested-sub">
              {#if px.program_name}{px.program_name} · {/if}
              from {px.trainer_name || 'your coach'}
              {#if px.notes} · {px.notes}{/if}
            </span>
          </div>
          <span class="material-symbols-rounded suggested-chev">chevron_right</span>
        </button>
      {/each}
    </div>
  {/if}

  {#if exercises.length > 0 && !loading}
    <div class="workout-title-row">
      {#if editingName}
        <input
          class="workout-title-input"
          type="text"
          bind:value={editNameValue}
          on:blur={commitName}
          on:keydown={e => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') cancelEditName(); }}
          autofocus
          placeholder={$_('diary.workout_name_placeholder')}
        />
      {:else}
        <button class="workout-title" on:click={startEditName} title={$_('diary.tap_to_rename')}>
          <span class="workout-title-text">{workoutName || 'Untitled workout'}</span>
          <span class="material-symbols-rounded title-edit-icon">edit</span>
        </button>
      {/if}
      {#if $todayLog?.program_week}
        <!-- Plan week this session was logged in (issue #13). Persisted on the
             log, so it stays accurate even after the athlete advances. -->
        <span class="week-chip" title="Program week this workout was logged in">
          Week {$todayLog.program_week}{#if $todayLog.program_duration_weeks} of {$todayLog.program_duration_weeks}{/if}
        </span>
      {/if}
    </div>
  {/if}

  <!-- (progress-strip removed: the data it carried — sets count, volume,
       timer — now lives in the single summary-bar above. This used to
       duplicate the fill + sets count, doubling visual weight at the top
       of the diary on every page load.) -->

  <!-- (now-strip lives in .diary-hud-col above — moved so it sits
       next to summary-bar in the desktop left column, and appears
       right below session progress on mobile.) -->

  <!-- Exercise list -->
  <div class="exercise-list">
    {#if loading}
      <Spinner block label="Loading workout…" />
    {:else if exercises.length === 0}
      <div class="empty-state">
        <span class="material-symbols-rounded empty-icon">{isFuture ? 'event_note' : 'fitness_center'}</span>
        <h3>{isFuture ? 'Plan ahead' : 'Ready to train?'}</h3>
        <p>{isFuture ? 'Schedule a workout for this day or add exercises manually.' : 'Pick a quick start, or build from scratch.'}</p>

        <!-- Quick-start cards: active program, coach pick, last workout.
             Replaces the plain Recent list with three tappable cards so
             the most likely "what should I do today" answers are one tap
             away. Cards only render when there's data; the buttons below
             still cover the manual path. -->
        <div class="quick-starts">
          {#if $activeProgram}
            <button class="quick-card" on:click={openLoadWorkout}>
              <span class="qc-tag">{$_('diary_extra.active_program')}</span>
              <span class="qc-title">{$activeProgram.name}</span>
              <span class="qc-meta">{$_('diary_extra.tap_pick_workout')}</span>
            </button>
          {/if}
          {#each suggestedPrescriptions.slice(0, 1) as px (px.id)}
            <button class="quick-card coach" on:click={() => startSuggestedPrescription(px)}>
              <span class="qc-tag">{$_('diary_extra.coach_pick')}</span>
              <span class="qc-title">{px.template_name || px.name || 'Coach workout'}</span>
              <span class="qc-meta">From {px.trainer_name || 'your coach'}</span>
            </button>
          {/each}
          {#each recentWorkouts.slice(0, 1) as rw (rw.id)}
            {@const exs = JSON.parse(rw.exercises || '[]')}
            <button class="quick-card" on:click={() => quickLoad(rw)}>
              <span class="qc-tag">{$_('diary_extra.last_workout')}</span>
              <span class="qc-title">{rw.name || 'Workout'}</span>
              <span class="qc-meta">{exs.length} {exs.length === 1 ? 'exercise' : 'exercises'}</span>
            </button>
          {/each}
        </div>

        <div class="empty-actions">
          <button class="btn btn-primary" on:click={openLoadWorkout}>
            <span class="material-symbols-rounded">calendar_month</span>
            Load Workout
          </button>
          <button class="btn btn-secondary" on:click={() => showPicker = true}>
            <span class="material-symbols-rounded">add</span>
            Add Exercise
          </button>
        </div>
      </div>
    {:else}
      {#each supersetGroups as group, gIdx (group.startIdx)}
        <!-- svelte-ignore a11y-no-static-element-interactions -->
        <div
          class="drag-group"
          data-ex-idx={group.startIdx}
          class:dragging={showDragReorder && draggedGroupIdx === gIdx}
          class:drag-over={showDragReorder && dragOverIdx === gIdx && draggedGroupIdx !== gIdx}
          draggable={showDragReorder}
          on:dragstart={e => showDragReorder && onGroupDragStart(e, gIdx)}
          on:dragover={e => showDragReorder && onGroupDragOver(e, gIdx)}
          on:drop={e => showDragReorder && onGroupDrop(e, gIdx)}
          on:dragend={showDragReorder ? onGroupDragEnd : null}
        >
          {#if group.type === 'superset'}
            <SupersetCard
              exercises={group.exercises}
              startIdx={group.startIdx}
              supersetId={group.supersetId}
              targetSets={group.targetSets}
              unit={$weightUnit}
              date={$currentDate}
              autoCollapse={$autoCollapseCompleted}
              feedback={$todayLog?.feedback || []}
              {prFlagsByIdx}
              {replyOpenId}
              {replyDrafts}
              {replySaving}
              onOpenReply={openReply}
              onSaveReply={saveReply}
              onCancelReply={() => replyOpenId = null}
              onDeleteReply={deleteReply}
              relTime={relInboxTime}
              {replySavedFlash}
              on:update={e => updateExercise(e.detail.idx, e.detail.exercise)}
              on:remove={e => removeExercise(e.detail.idx)}
              on:removeSuperset={e => removeSuperset(e.detail)}
              on:addToSuperset={e => openSupersetPicker(e.detail)}
              on:menu={e => openExMenu(e.detail.idx)}
              on:info={e => openInfoSheet(e.detail.idx)}
              on:moveWithinSuperset={e => moveWithinSuperset(e.detail)}
            />
          {:else}
            <ExerciseCard
              exercise={group.exercises[0]}
              idx={group.startIdx}
              unit={$weightUnit}
              date={$currentDate}
              canMoveUp={showReorderButtons && group.startIdx > 0}
              canMoveDown={showReorderButtons && group.startIdx < exercises.length - 1}
              autoCollapse={$autoCollapseCompleted}
              prSetIndices={prFlagsByIdx[group.startIdx]}
              on:update={e => updateExercise(group.startIdx, e.detail)}
              on:remove={() => removeExercise(group.startIdx)}
              on:moveUp={() => moveExercise(group.startIdx, -1)}
              on:moveDown={() => moveExercise(group.startIdx, 1)}
              on:menu={() => openExMenu(group.startIdx)}
              on:info={() => openInfoSheet(group.startIdx)}
            />
          {/if}
          <!-- Per-exercise coach feedback for single-exercise groups.
               Supersets render their feedback INSIDE the SupersetCard
               next to each member exercise, so they get filtered out
               here to avoid duplicate display below the whole block. -->
          {#if group.type !== 'superset'}
            {#each group.exercises as gEx, gOff}
              {#each ($todayLog?.feedback || []).filter(f => f.exercise_idx === group.startIdx + gOff) as f (f.id)}
                <div class="ex-feedback" in:fade={{ duration: 180 }}>
                  <div class="avatar-chip coach sm">
                    {#if f.trainer_avatar_url}
                      <img src={resolveAssetUrl(f.trainer_avatar_url)} alt="" />
                    {:else}
                      {(f.trainer_name || 'C')[0].toUpperCase()}
                    {/if}
                  </div>
                  <div class="ex-feedback-body">
                    <span class="ex-feedback-text">
                      <strong>{f.trainer_name || 'Coach'}:</strong> {f.note}
                    </span>
                    {#if f.updated_at}
                      <span class="ex-feedback-time">{relInboxTime(f.updated_at)}</span>
                    {/if}
                    {#if replyOpenId === f.id}
                      <div class="reply-edit">
                        <textarea class="reply-input" rows="2"
                          bind:value={replyDrafts[f.id]}
                          placeholder={$_('diary_extra.reply_ph')}></textarea>
                        <div class="reply-actions">
                          {#if f.member_reply}
                            <button class="reply-link danger" on:click={() => deleteReply(f.id)}>{$_('diary_extra.delete')}</button>
                          {/if}
                          <button class="reply-link" on:click={() => replyOpenId = null}>{$_('diary_extra.cancel')}</button>
                          <button class="reply-save"
                                  on:click={() => saveReply(f.id)}
                                  disabled={replySaving === f.id || !(replyDrafts[f.id] || '').trim()}>
                            {replySaving === f.id ? 'Saving…' : 'Reply'}
                          </button>
                        </div>
                      </div>
                    {:else if f.member_reply}
                      <button class="my-reply" on:click={() => openReply(f)}>
                        <span class="my-reply-label">You replied:</span>
                        <span class="my-reply-text">{f.member_reply}</span>
                        <span class="material-symbols-rounded my-reply-edit-icon">edit</span>
                      </button>
                    {:else}
                      <button class="reply-add" on:click={() => openReply(f)}>
                        <span class="material-symbols-rounded" style="font-size:14px">reply</span>
                        Reply
                      </button>
                    {/if}
                  </div>
                </div>
              {/each}
            {/each}
          {/if}
        </div>
      {/each}

      <!-- Notes (collapsed unless user expands or notes exist) -->
      {#if notesExpanded || notes?.trim()}
        <div class="notes-card">
          <textarea
            class="notes-input"
            placeholder={$_('diary_extra.notes_ph')}
            bind:value={notes}
            on:blur={saveNotes}
            rows="2"
          ></textarea>
        </div>
      {:else}
        <button class="notes-trigger" on:click={() => notesExpanded = true}>
          <span class="material-symbols-rounded">edit_note</span>
          Add workout notes
        </button>
      {/if}

      <!-- Finish workout — explicit end-of-session. Visible once at least one
           set is logged; re-opens the summary if already completed. -->
      {#if stats.completed > 0 && !isFuture}
        <button class="finish-btn" class:reopen={$todayLog?.completed} on:click={() => finishWorkout({ auto: false })}>
          <span class="material-symbols-rounded">
            {$todayLog?.completed ? 'task_alt' : 'flag'}
          </span>
          <span class="finish-text">
            {$todayLog?.completed ? 'View workout summary' : 'Finish workout'}
          </span>
          {#if !$todayLog?.completed}
            <span class="finish-sub">{stats.completed}/{stats.total} sets · {formatTimerMs($timerMs, { centi: false })}</span>
          {/if}
        </button>
      {/if}
    {/if}
  </div>

  <!-- Cardio sessions for the current date. Opt-in per user (see
       settings.cardioEnabled — off by default for pure lifters).
       Sits OUTSIDE the exercises-length guard so cardio can be logged
       on rest days without needing to add a lifting exercise first. -->
  {#if $cardioEnabled}
    <div class="cardio-slot">
      <CardioCard />
    </div>
  {/if}

  </div><!-- /.diary-main-col -->

  <!-- Right rail — program context. Only renders visibly at >=1280px
       (mobile CSS sets display:none). NT-parity: pinned mode portals
       to document.body so position:fixed resolves against the viewport
       (not against .page-transition, which has will-change:transform
       and breaks fixed positioning for descendants). Hidden+overlay
       mode renders the same {@render railWidgets()} snippet as a
       fixed overlay outside .diary-body. The snippet itself is
       defined at outer scope below so both call sites can reach it. -->
  {#if _railMode === 'pinned'}
    <aside
      use:portal
      class="diary-right-rail"
      aria-label="Program context"
      bind:this={_diaryRightRailEl}
      style="--diary-rail-top:{_railStickyTopPx}px; --diary-rail-left:{_railFixedLeftPx}px; --diary-rail-width:{_railFixedWidthPx}px">
      {@render railWidgets()}
    </aside>
  {/if}

  </div><!-- /.diary-body -->

  <!-- Portaled edge tab: only visible on wide viewports when the rail
       is hidden. Tap toggles the overlay open/closed. Chevron flips
       to signal which action the tab performs next. -->
  {#if _railMode === 'hidden' && _wideViewport}
    <button
      use:portal
      type="button"
      class="rail-edge-tab"
      on:click={railToggleOverlay}
      aria-label={_railOverlay ? 'Close widget panel' : 'Open widget panel'}
      aria-expanded={_railOverlay}
      title={_railOverlay ? 'Close widgets' : 'Show widgets'}
    >
      <span class="material-symbols-rounded" style="pointer-events:none">
        {_railOverlay ? 'chevron_right' : 'chevron_left'}
      </span>
    </button>
  {/if}

  <!-- Hidden+overlay: portaled fixed slide-in that reuses the same
       widget snippet. Only mounts when the overlay is actually open
       so widgets don't double-instantiate under the pinned aside. -->
  {#if _railMode === 'hidden' && _railOverlay && _wideViewport}
    <aside use:portal class="diary-right-rail diary-right-rail-overlay" aria-label="Program context">
      {@render railWidgets()}
    </aside>
  {/if}

{#snippet railWidgets()}
  <!-- Rail title bar. Always the first row of the widget stack —
       gives the panel a clear identity and a consistent home for
       the mode controls (pin/hide/close). Icons match NT so both
       apps read as one system. -->
  <header class="rail-title">
    <span class="rail-title-text">Overview</span>
    <div class="rail-title-actions">
      {#if _railMode === 'pinned'}
        <button
          type="button"
          class="rail-ctrl-btn"
          on:click={railHide}
          aria-label="Hide widget panel"
          title="Hide widgets (edge tab reopens)"
        >
          <span class="material-symbols-rounded">right_panel_close</span>
        </button>
      {:else}
        <button
          type="button"
          class="rail-ctrl-btn"
          on:click={railPin}
          aria-label="Pin widget panel"
          title="Pin widgets"
        >
          <span class="material-symbols-rounded">push_pin</span>
        </button>
        <button
          type="button"
          class="rail-ctrl-btn"
          on:click={() => _railOverlay = false}
          aria-label="Close widget panel"
          title="Close"
        >
          <span class="material-symbols-rounded">close</span>
        </button>
      {/if}
    </div>
  </header>
  <!-- 7-day peek — always visible. Dots colored by whether that
       date has any completed set in workoutDateSet. Today gets a
       ring. Clicking a day jumps the diary to that date. -->
  <div class="rail-card">
      <div class="rail-card-head">
        <span class="material-symbols-rounded">calendar_view_week</span>
        <span class="rail-card-title">This Week</span>
        <span class="rail-card-count">{weekWorkoutCount}/7</span>
      </div>
      <div class="rail-week-strip">
        {#each weekPeekDays as day (day.key)}
          <button
            type="button"
            class="rail-week-day"
            class:done={day.done}
            class:today={day.isToday}
            on:click={() => currentDate.set(day.key)}
            title={day.key}>
            <span class="rail-week-dow">{day.dow}</span>
            <span class="rail-week-dom">{day.dom}</span>
            <span class="rail-week-dot" class:on={day.done}></span>
          </button>
        {/each}
      </div>
      {#if streakCount >= 2}
        <div class="rail-card-meta">🔥 {streakCount}-day streak</div>
      {/if}
    </div>
    {#if recentWorkouts.length > 0}
      <div class="rail-card">
        <div class="rail-card-head">
          <span class="material-symbols-rounded">history</span>
          <span class="rail-card-title">Recent</span>
        </div>
        <div class="rail-recent-list">
          {#each recentWorkouts as w (w.date)}
            <button type="button" class="rail-recent-row" on:click={() => currentDate.set(w.date)}>
              <span class="rail-recent-date">{new Date(w.date + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
              <span class="rail-recent-name">{w.workout_name || 'Untitled workout'}</span>
            </button>
          {/each}
        </div>
      </div>
    {/if}
    {#if $activeProgram}
      <div class="rail-card">
        <div class="rail-card-head">
          <span class="material-symbols-rounded">event_note</span>
          <span class="rail-card-title">{$activeProgram.name}</span>
        </div>
        {#if $todayLog?.program_week}
          <div class="rail-card-meta">
            Week {$todayLog.program_week}{#if $todayLog.program_duration_weeks} of {$todayLog.program_duration_weeks}{/if}
          </div>
        {:else if $activeProgram.duration_weeks}
          <div class="rail-card-meta">
            {$activeProgram.duration_weeks}-week program
          </div>
        {/if}
      </div>
    {/if}
    {#if $todayPrescription}
      <div class="rail-card">
        <div class="rail-card-head">
          <span class="material-symbols-rounded">assignment</span>
          <span class="rail-card-title">Today's Plan</span>
        </div>
        <div class="rail-card-body">
          <div class="rail-plan-name">{$todayPrescription.template_name || $todayPrescription.name || 'Scheduled workout'}</div>
          {#if $todayPrescription.day_label}
            <div class="rail-plan-sub">{$todayPrescription.day_label}</div>
          {/if}
        </div>
      </div>
    {/if}
    <!-- (Session stats card removed — .diary-hud-col in the left
         column already owns session progress; two Session displays
         on one screen was redundant. Live stats stay in the summary
         bar over there.) -->
    <button class="rail-action" on:click={openLoadWorkout}>
      <span class="material-symbols-rounded">library_books</span>
      Load Workout
    </button>
    <!-- Body Stats — summary widget (weight + measurements +
         Log CTA) matching NT's BodyStatsWidget pattern. The full
         entry form still lives in the modal (showBodyStats) which
         the Log Stats and open-full icon both trigger. -->
    <BodyStatsWidget onOpen={() => showBodyStats = true} />
    <!-- Gym Tools — utilities inline (plate calc, converter).
         Not status data so it stays as-is (no summary view to
         port from NT — NT doesn't have gym tools). -->
    <GymTools embed />
    <!-- Workout Actions widget — desktop rail gets the actions
         inline as a card instead of the tiny hamburger launcher
         (which read as "half a widget" next to the full cards
         above it). Mobile still opens the ActionSheet via the
         top-right ⋮ button; both surfaces share `workoutActions`
         so the labels stay in sync. Clear row picks up the
         .danger variant so destruction reads clearly. -->
    <div class="rail-card rail-actions-card">
      <div class="rail-card-head">
        <span class="material-symbols-rounded">tune</span>
        <span class="rail-card-title">Workout Actions</span>
      </div>
      <div class="rail-actions-list">
        {#each workoutActions as a (a.value)}
          <button type="button"
                  class="rail-action-row"
                  class:danger={a.danger}
                  on:click={() => _runWorkoutAction(a.value)}
                  aria-label={a.label}
                  title={a.label}>
            <span class="material-symbols-rounded">{a.icon}</span>
            <span class="rail-action-row-label">{a.label}</span>
          </button>
        {/each}
      </div>
    </div>
{/snippet}

  <!-- Add-exercise FAB (visible only mid-workout — empty state has its own buttons).
       Loading from a program mid-workout lives in the ⋮ menu as "Replace workout". -->
  {#if exercises.length > 0}
    <div class="fab-group" class:positioned={!!addFabPos} style={addFabStyle}>
      <button
        class="fab fab-primary"
        on:pointerdown={startAddFabDrag}
        on:click={handleAddFabClick}
        aria-label="Add exercise · drag to reposition"
        title="Tap to add exercise · hold and drag to move"
      >
        <span class="material-symbols-rounded">add</span>
      </button>
    </div>
  {/if}

  <!-- Exercise picker -->
  <Sheet open={showPicker} on:close={() => { showPicker = false; replacingIdx = null; pickerTargetSupersetId = null; }} height="full" wide>
    <ExercisePicker on:select={e => addExercise(e.detail)} />
  </Sheet>

  <SmartLogModal
    bind:open={showSmartLog}
    date={$currentDate}
    existingLog={$todayLog}
    onSave={handleSmartLogSave}
  />

  <!-- Load Workout sheet -->
  <Sheet open={showLoadWorkout} on:close={() => { showLoadWorkout = false; selectedProgram = null; }}>
    <div class="load-workout">
      <h3 class="lw-title">{$_('diary_extra.load_workout')}</h3>

      {#if loadingPrograms}
        <div class="lw-loading">Loading programs...</div>
      {:else if programs.length === 0}
        <div class="lw-empty">
          <p>No programs found. Create one in the Programs tab.</p>
        </div>
      {:else}
        <!-- Program selector -->
        <div class="lw-programs">
          {#each programs as p}
            <button
              class="lw-program-btn"
              class:active={selectedProgram?.id === p.id}
              on:click={() => selectProgram(p.id)}
            >
              {p.name}
              {#if p.is_active}<span class="lw-active-dot"></span>{/if}
            </button>
          {/each}
        </div>

        <!-- Multi-week progression: current plan week + repeat/regress. Only
             shown for a progressed program (duration_weeks > 1). -->
        {#if selectedProgram?.duration_weeks > 1 && selectedProgram?.is_active}
          <div class="lw-week-bar">
            <button class="lw-week-nav" title="Regress a week"
              disabled={(selectedProgram.current_week || 1) <= 1}
              on:click={() => setPlanWeek((selectedProgram.current_week || 1) - 1)}>
              <span class="material-symbols-rounded">chevron_left</span>
            </button>
            <span class="lw-week-label">Week {selectedProgram.current_week || 1} of {selectedProgram.duration_weeks}</span>
            <button class="lw-week-nav" title="Advance a week"
              disabled={selectedProgram.on_complete !== 'repeat' && (selectedProgram.current_week || 1) >= selectedProgram.duration_weeks}
              on:click={advancePlanWeek}>
              <span class="material-symbols-rounded">chevron_right</span>
            </button>
            <button class="lw-week-auto" title="Resume automatic week tracking"
              on:click={() => setPlanWeek(null)}>{$_('diary_extra.auto')}</button>
          </div>
        {/if}

        <!-- Templates list — restored to the original single-button-per-row
             layout that was reliably full-width. The info preview is now
             reached via the small "i" badge tucked into the right edge of
             the same button (stops propagation so it doesn't trigger the
             row's main load action). -->
        {#if selectedProgram?.templates?.length}
          <div class="lw-templates">
            {#each selectedProgram.templates as t, idx}
              <button class="lw-template" on:click={() => loadTemplate(t)}>
                <span class="lw-tpl-num">{idx + 1}</span>
                <div class="lw-tpl-info">
                  <span class="lw-tpl-name">{t.name}</span>
                  <span class="lw-tpl-meta">{(t.exercises || []).length} exercises</span>
                </div>
                <span class="lw-tpl-info-badge"
                  role="button" tabindex="0"
                  aria-label="Show {t.name} details" title="Show details"
                  on:click|stopPropagation={() => openTemplateInfo(t)}
                  on:keydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openTemplateInfo(t); } }}>
                  <span class="material-symbols-rounded">info</span>
                </span>
                <span class="material-symbols-rounded lw-tpl-arrow">chevron_right</span>
              </button>
            {/each}
          </div>
        {:else if selectedProgram}
          <p class="lw-empty">This program has no workout templates.</p>
        {:else}
          <p class="lw-hint">Select a program above to see its workouts.</p>
        {/if}
      {/if}
    </div>
  </Sheet>

  <!-- Template info preview sheet — shows the contents of a workout
       template (exercise list with target sets/reps/weight, superset
       grouping pills) without loading it into the diary. Equivalent to
       NutriTrace's meal/recipe info-button → contents sheet on the Foods
       picker. The "Load Workout" CTA at the bottom hands off to the
       existing loadTemplate() flow. -->
  <Sheet open={templateInfo != null}
    title={templateInfo ? templateInfo.name : ''}
    on:close={() => templateInfo = null}>
    {#if templateInfo}
      <div class="tpl-info-body">
        {#if templateInfo.day_label}
          <div class="tpl-info-meta">{templateInfo.day_label}</div>
        {/if}
        {#if (templateInfo.exercises || []).length === 0}
          <p class="lw-empty" style="padding:24px 0">This template has no exercises yet.</p>
        {:else}
          <div class="tpl-info-list">
            {#each templateInfo.exercises as ex, i}
              {@const prevSsId = i > 0 ? templateInfo.exercises[i - 1]?.superset_id : null}
              {@const showSsHeader = ex.superset_id && ex.superset_id !== prevSsId}
              {#if showSsHeader}
                <div class="tpl-info-ss-header">
                  <span class="material-symbols-rounded" style="font-size:14px">link</span>
                  Superset
                </div>
              {/if}
              <div class="tpl-info-row" class:in-superset={!!ex.superset_id}>
                <span class="tpl-info-row-num">{i + 1}</span>
                <div class="tpl-info-row-text">
                  <span class="tpl-info-row-name">{ex.exercise_name}</span>
                  <span class="tpl-info-row-target">{_fmtTplExerciseTarget(ex)}</span>
                  {#if ex.notes}<span class="tpl-info-row-notes">{ex.notes}</span>{/if}
                </div>
              </div>
            {/each}
          </div>
        {/if}
        <button class="btn btn-primary tpl-info-cta"
          on:click={loadFromInfo}
          disabled={!(templateInfo.exercises || []).length}>
          <span class="material-symbols-rounded" style="font-size:18px">play_arrow</span>
          Load Workout
        </button>
      </div>
    {/if}
  </Sheet>

  <!-- Workout actions sheet -->
  <ActionSheet
    bind:open={showWorkoutActions}
    title="Workout"
    actions={workoutActions}
    on:select={handleWorkoutAction}
    on:cancel={() => showWorkoutActions = false}
  />

  <!-- Per-exercise action sheet (superset actions) -->
  <ActionSheet
    bind:open={exActionsOpen}
    title={exActionsTitle}
    actions={exActionsList}
    on:select={handleExAction}
    on:cancel={() => exActionsOpen = false}
  />

  <!-- Join existing superset picker -->
  <Sheet bind:open={joinPickerOpen} title="Add to Superset">
    <div class="ss-picker-body">
      <p class="ss-picker-hint">Choose which superset to join:</p>
      {#each existingSupersets as ss}
        <button class="ss-option" on:click={() => handleJoinSs(ss.id)}>
          <span class="material-symbols-rounded ss-option-icon">link</span>
          <div class="ss-option-info">
            <span class="ss-option-count">{ss.names.length} exercises</span>
            <span class="ss-option-names">{ss.names.join(' · ')}</span>
          </div>
        </button>
      {/each}
    </div>
  </Sheet>

  <!-- Create new superset: pick companions -->
  <Sheet bind:open={newSsPickerOpen} title="Create Superset">
    <div class="ss-picker-body">
      <p class="ss-picker-hint">
        Group exercises with <strong>{exercises[exActionsIdx]?.exercise_name || ''}</strong>:
      </p>
      <div class="ss-pick-list">
        {#each exercises as ex, i}
          {#if i !== exActionsIdx && !(ex.superset_id != null && ex.superset_size > 1)}
            <label class="ss-pick-row">
              <input type="checkbox" bind:group={newSsPicks} value={i} />
              <span class="ss-pick-name">{ex.exercise_name}</span>
            </label>
          {/if}
        {/each}
      </div>
      <button class="btn btn-primary ss-confirm" disabled={newSsPicks.length === 0} on:click={handleCreateSs}>
        Create superset ({newSsPicks.length + 1} exercises)
      </button>
    </div>
  </Sheet>

  <!-- Calendar date picker (NutriTrace-style portal sheet) -->
  {#if showDatePicker}
    <!-- svelte-ignore a11y-click-events-have-key-events -->
    <!-- svelte-ignore a11y-no-static-element-interactions -->
    <div use:portal class="dp-backdrop"
      in:fade={{ duration: 180 }} out:fade={{ duration: 140 }}
      on:click={() => showDatePicker = false}>
      <div class="dp-sheet"
        in:fly={{ y: 60, duration: 260, easing: cubicOut }}
        out:fly={{ y: 60, duration: 180 }}
        on:click|stopPropagation>
        <div class="dp-handle"></div>
        <div class="dp-nav">
          <button class="btn-icon dp-nav-btn" on:click={calPrevMonth}>
            <span class="material-symbols-rounded">chevron_left</span>
          </button>
          <div class="dp-month-year">
            <button class="dp-month-btn" on:click={() => { showMonthPicker = !showMonthPicker; showYearPicker = false; }}>
              {calMonthName}<span class="material-symbols-rounded" style="font-size:14px;vertical-align:middle;margin-left:2px">{showMonthPicker ? 'expand_less' : 'expand_more'}</span>
            </button>
            <button class="dp-year-btn" on:click={() => { showYearPicker = !showYearPicker; showMonthPicker = false; }}>
              {calYear}<span class="material-symbols-rounded" style="font-size:14px;vertical-align:middle;margin-left:2px">{showYearPicker ? 'expand_less' : 'expand_more'}</span>
            </button>
          </div>
          <button class="btn-icon dp-nav-btn" on:click={calNextMonth}>
            <span class="material-symbols-rounded">chevron_right</span>
          </button>
        </div>

        {#if showYearPicker}
          <div class="dp-year-grid">
            {#each yearRange as y}
              <button class="dp-yr-btn" class:dp-yr-sel={y === calYear} on:click={() => calPickYear(y)}>{y}</button>
            {/each}
          </div>
        {:else if showMonthPicker}
          <div class="dp-month-grid">
            {#each ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'] as m, i}
              <button class="dp-mo-btn" class:dp-mo-sel={i === calMonth} on:click={() => calPickMonth(i)}>{m}</button>
            {/each}
          </div>
        {:else}
          <div class="dp-grid">
            {#each DAY_LABELS as d}<div class="dp-dh">{d}</div>{/each}
            {#each Array(calFirstDay) as _}<div></div>{/each}
            {#each Array(calDaysInMonth) as _, i}
              {@const day = i + 1}
              {@const dateStr = `${calYear}-${String(calMonth+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`}
              {@const hasUnread = unreadFeedbackDates.has(dateStr)}
              <button class="dp-day"
                class:dp-today={calIsToday(day)}
                class:dp-sel={calIsSel(day)}
                class:dp-has-workout={calHasWorkout(day)}
                class:dp-has-feedback={hasUnread}
                on:click={() => calPickDay(day)}
              >
                {day}
                {#if calHasWorkout(day)}<span class="dp-dot"></span>{/if}
                {#if hasUnread}<span class="dp-dot dp-dot-feedback"></span>{/if}
              </button>
            {/each}
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>

<BodyStats bind:open={showBodyStats} />
<GymTools bind:open={showGymTools} />

<!-- Coach Feedback Inbox — list every note the member's coach has left.
     Tapping a row marks that specific row seen and jumps to the workout's
     date. "Mark All Seen" clears the inbox without navigating. -->
<Sheet open={showCoachInbox} on:close={() => showCoachInbox = false} title="Coach Feedback">
  <div class="inbox-sheet">
    {#if !inboxLoading && inboxRows.some(r => !r.seen_by_member_at)}
      <div class="inbox-toolbar">
        <button class="btn-link" on:click={markAllInboxSeen}>{$_('diary_extra.mark_all_seen')}</button>
      </div>
    {/if}
    {#if inboxLoading}
      <div class="inbox-empty">Loading…</div>
    {:else if inboxRows.length === 0}
      <div class="inbox-empty">No feedback yet.</div>
    {:else}
      {#each inboxRows as r (r.id)}
        <button class="inbox-row" class:unread={!r.seen_by_member_at}
                on:click={() => inboxOpenDate(r)}>
          <span class="material-symbols-rounded inbox-icon">comment</span>
          <div class="inbox-body">
            <span class="inbox-title">
              {r.trainer_name || 'Coach'} ·
              {new Date(r.workout_date + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
              {#if r.exercise_name} · {r.exercise_name}{/if}
            </span>
            <span class="inbox-note">{r.note}</span>
            <span class="inbox-time">{relInboxTime(r.updated_at)}</span>
          </div>
          {#if !r.seen_by_member_at}<span class="inbox-dot" aria-hidden="true"></span>{/if}
        </button>
      {/each}
    {/if}
  </div>
</Sheet>
<WorkoutSummary bind:open={showSummary} workout={$todayLog} prCount={prCountToday} streak={streakCount} onDurationChange={handleSummaryDurationChange} />
<ExerciseInfoSheet bind:open={infoSheetOpen} exerciseId={infoSheetExerciseId} exerciseName={infoSheetExerciseName} on:replace={handleInfoReplace} />

<style>
  .page {
    min-height: 100dvh;
    background: var(--bg);
    padding-bottom: calc(var(--nav-h) + var(--safe-bottom) + var(--mini-player-h, 0px) + 80px);
  }

  /* Pull-to-refresh indicator. Lives above the page header at translate
     Y=0 (out of view), the touch handler shifts it down based on pull
     distance. .refreshing locks it at 60px while loading completes. */
  .ptr-indicator {
    position: fixed;
    top: var(--safe-top, 0);
    left: 50%;
    width: 36px; height: 36px;
    border-radius: 50%;
    background: var(--surface-1); border: 1px solid var(--border);
    box-shadow: 0 2px 8px rgba(0,0,0,0.3);
    display: flex; align-items: center; justify-content: center;
    color: var(--accent);
    z-index: 200;
    pointer-events: none;
    transition: transform 0.15s ease-out, opacity 0.15s ease-out;
  }
  .ptr-indicator.refreshing {
    transition: transform 0.3s ease-out;
  }
  .ptr-indicator .material-symbols-rounded { font-size: 20px; transition: transform 0.08s linear; }
  .ptr-indicator .spin { animation: ptr-spin 0.8s linear infinite; }
  @keyframes ptr-spin { to { transform: rotate(360deg); } }

  /* Action icons fixed at top-right, same level as hamburger */
  :global(.diary-topbar-actions) {
    position: fixed;
    top: calc(var(--safe-top, 0px) + 10px);
    right: 12px;
    z-index: 41;
    display: flex;
    align-items: center;
    gap: 2px;
    pointer-events: all;
  }

  /* Sticky date sub-bar — sits directly below the page-header.
     Compact (banner-off) header: page-top + 10 (pad-top) + ~40 (h1)
                                + 0 (pad-bottom, removed) = page-top + 50.
     Banner-on: extra 60px for the illustration's padding-bottom. */
  /* Sticky-top wrapper — pins the page header and the date sub-bar
     together as one block so the date row doesn't drift relative to
     the header during scroll. The nested .page-header is forced to
     static (!important to override base.css's .page-header sticky
     rule) so it doesn't double-stick inside this container. */
  .diary-sticky-top {
    position: sticky;
    top: 0;
    z-index: 20;
    background: var(--bg);
  }
  :global(.diary-sticky-top .page-header) {
    position: static !important;
    top: auto !important;
    z-index: auto !important;
  }
  .date-nav {
    background: var(--glass-surface);
    backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
    border-bottom: 1px solid var(--border);
    padding: 6px var(--page-px);
    display: flex; align-items: center; justify-content: space-between;
    gap: 4px;
  }
  .nav-btn {
    width: 32px; height: 32px;
    border-radius: var(--radius-md);
    background: var(--surface-2); border: 1px solid var(--border);
    display: flex; align-items: center; justify-content: center;
    cursor: pointer; color: var(--text-2);
    transition: all var(--dur-fast);
    flex-shrink: 0;
  }
  .nav-btn .material-symbols-rounded { font-size: 20px; }
  .nav-btn:active { transform: scale(0.92); }

  .date-center {
    display: flex; flex-direction: column; align-items: center; gap: 1px;
    flex: 1; min-width: 0;
  }
  .date-btn {
    flex: 1;
    display: flex; flex-direction: column; align-items: center;
    background: none; border: none; cursor: pointer;
    gap: 1px;
  }
  .date-label {
    display: flex; flex-direction: column; align-items: center; gap: 0;
    background: none; border: none; cursor: pointer; color: var(--accent);
    padding: 0;
  }
  .date-text { font-size: 17px; font-weight: 700; color: var(--accent); line-height: 1.15; }
  .date-sub  { font-size: 12px; color: var(--text-3); line-height: 1.1; }

  .today-pill {
    display: inline-flex; align-items: center; gap: 3px;
    padding: 1px 8px 1px 5px;
    border-radius: var(--radius-full);
    background: var(--accent-dim);
    border: 1px solid var(--accent);
    color: var(--accent);
    font-size: 10px; font-weight: 700;
    cursor: pointer;
    transition: all var(--dur-fast);
  }
  .today-pill:active { transform: scale(0.95); }
  .today-pill-icon { font-size: 12px; }

  /* Streak chip — small motivational pill near the date showing
     consecutive training days. Hides at 0-1 (no streak to flex yet). */
  .streak-chip {
    display: inline-flex; align-items: center; gap: 3px;
    padding: 2px 8px;
    border-radius: var(--radius-full);
    background: color-mix(in srgb, #ff7a00 16%, transparent);
    border: 1px solid color-mix(in srgb, #ff7a00 35%, transparent);
    color: #ff7a00;
    font-size: 11px; font-weight: 700;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .nav-right {
    display: flex; align-items: center; gap: 6px;
  }

  /* Workout name bar */
  .workout-name-bar {
    display: flex; align-items: center; gap: 8px;
    padding: 8px var(--page-px);
    background: var(--accent-dim);
    border-bottom: 1px solid var(--border);
  }
  .wn-icon { font-size: 18px; color: var(--accent); }
  .wn-text { font-size: 13px; font-weight: 600; color: var(--accent); }

  .summary-bar {
    position: relative;
    display: flex; align-items: center; justify-content: space-between;
    gap: 12px;
    padding: 10px var(--page-px);
    background: var(--surface-1);
    border-bottom: 1px solid var(--border);
    overflow: hidden;
    /* Each stat shrinks proportionally instead of pushing past the edges. */
  }
  .summary-bar > .stat {
    flex: 0 1 auto; min-width: 0;
  }
  .summary-bar .stat-val {
    font-weight: 700; color: var(--text-1);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .summary-bar .stat-label {
    color: var(--text-3); font-size: 12px;
  }
  /* On narrow phones the row was hitting both edges, clipping "23/27 Sets"
     on the left and crowding the timer pill on the right. Tighten the gap,
     hide the descriptive stat labels (icons + values still tell the story),
     and let the timer button sit at the right edge without being squashed. */
  @media (max-width: 480px) {
    .summary-bar { gap: 6px; padding: 10px 10px; }
    .summary-bar .stat-label { display: none; }
    .summary-bar .stat-icon { font-size: 18px; }
    .summary-bar .stat-val { font-size: 14px; }
  }
  /* Accent-colored horizontal fill behind the stats that grows with set
     completion — turns the stat row into a subtle "progress bar". */
  .sb-fill {
    position: absolute; top: 0; left: 0; bottom: 0;
    background: linear-gradient(
      90deg,
      color-mix(in srgb, var(--accent) 14%, transparent),
      color-mix(in srgb, var(--accent) 22%, transparent)
    );
    border-right: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
    transition: width 0.3s ease;
    pointer-events: none;
    z-index: 0;
  }
  .summary-bar.done .sb-fill {
    background: linear-gradient(
      90deg,
      color-mix(in srgb, var(--success, #2FD66F) 16%, transparent),
      color-mix(in srgb, var(--success, #2FD66F) 24%, transparent)
    );
    border-right-color: color-mix(in srgb, var(--success, #2FD66F) 50%, transparent);
  }
  .summary-bar > .stat,
  .summary-bar > :not(.sb-fill) { position: relative; z-index: 1; }
  .stat { display: flex; align-items: center; gap: 6px; }

  /* "Now doing" pill */
  .now-strip {
    display: flex; align-items: center; gap: 10px;
    width: calc(100% - var(--page-px) * 2);
    margin: 10px var(--page-px) 0;
    padding: 10px 14px;
    background: color-mix(in srgb, var(--accent) 14%, var(--surface-1));
    border: 1px solid color-mix(in srgb, var(--accent) 50%, transparent);
    border-radius: var(--radius-md);
    color: var(--text-1);
    font-family: inherit; text-align: left;
    cursor: pointer;
    transition: transform var(--dur-fast), background var(--dur-fast);
  }
  .now-strip:hover  { background: color-mix(in srgb, var(--accent) 20%, var(--surface-1)); }
  .now-strip:active { transform: scale(0.99); }
  .now-icon {
    font-size: 22px; color: var(--accent); flex-shrink: 0;
    background: var(--surface-1); border-radius: 50%;
    padding: 2px;
  }
  .now-info { flex: 1; display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .now-label {
    font-size: 9px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase;
    color: var(--accent);
  }
  .now-exercise {
    font-size: 14px; font-weight: 700; color: var(--text-1);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .now-set {
    font-size: 12px; font-weight: 700; color: var(--accent);
    padding: 3px 10px; border-radius: var(--radius-full);
    background: color-mix(in srgb, var(--accent) 18%, transparent);
    flex-shrink: 0;
    font-variant-numeric: tabular-nums;
  }
  .now-chev { color: var(--accent); opacity: 0.6; flex-shrink: 0; }
  .stat-icon { font-size: 18px; color: var(--accent); }
  .stat-val  { font-size: 15px; font-weight: 700; color: var(--text-1); }
  .stat-label { font-size: 12px; color: var(--text-3); }

  /* Wake lock toggle */
  .wake-toggle {
    width: 36px; height: 36px;
    border-radius: var(--radius-md);
    background: var(--surface-2); border: 1px solid var(--border);
    display: flex; align-items: center; justify-content: center;
    cursor: pointer; color: var(--text-3);
    transition: all var(--dur-fast);
    flex-shrink: 0;
  }
  .wake-toggle .material-symbols-rounded { font-size: 20px; }
  .wake-toggle.active {
    background: var(--accent-dim);
    border-color: var(--accent);
    color: var(--accent);
  }
  .wake-toggle:active { transform: scale(0.92); }

  .exercise-list { padding: 12px var(--page-px); display: flex; flex-direction: column; gap: 12px; }

  /* Inline workout title */
  .workout-title-row { padding: 8px var(--page-px) 0; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .week-chip {
    flex-shrink: 0;
    padding: 3px 10px;
    background: var(--accent-dim); color: var(--accent);
    border-radius: var(--radius-full);
    font-size: 12px; font-weight: 800; white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .workout-title {
    display: inline-flex; align-items: center; gap: 6px;
    background: none; border: none; cursor: pointer;
    color: var(--text-1); font-size: 18px; font-weight: 700;
    padding: 4px 8px; margin-left: -8px;
    border-radius: var(--radius-sm);
    letter-spacing: -0.01em;
    font-family: inherit;
    transition: background var(--dur-fast);
  }
  .workout-title:hover { background: var(--surface-2); }
  .title-edit-icon { font-size: 14px; color: var(--text-3); opacity: 0.5; transition: opacity var(--dur-fast); }
  .workout-title:hover .title-edit-icon { opacity: 1; color: var(--accent); }
  .workout-title-input {
    width: 100%;
    background: var(--surface-2); border: 1px solid var(--accent);
    border-radius: var(--radius-sm);
    padding: 6px 10px;
    color: var(--text-1); font-size: 18px; font-weight: 700;
    outline: none; font-family: inherit;
    letter-spacing: -0.01em;
  }

  /* Session progress strip — sits under coach-banner / rest-timer, above exercises */
  .progress-strip {
    margin: 6px var(--page-px) 0;
    padding: 10px 14px;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    display: flex; flex-direction: column; gap: 10px;
  }
  .progress-strip.done { border-color: var(--success); background: linear-gradient(135deg, color-mix(in srgb, var(--success) 10%, transparent), var(--surface-1)); }
  .ps-bar { height: 4px; background: var(--surface-2); border-radius: var(--radius-full); overflow: hidden; }
  .ps-fill {
    height: 100%;
    background: linear-gradient(90deg, var(--accent), var(--accent-2));
    border-radius: var(--radius-full);
    transition: width var(--dur-base) var(--ease-out);
    box-shadow: 0 0 10px var(--accent-dim);
  }
  .progress-strip.done .ps-fill { background: var(--success); box-shadow: 0 0 10px color-mix(in srgb, var(--success) 40%, transparent); }
  .ps-stats { display: flex; align-items: center; gap: 10px; }
  .ps-stat { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 2px; min-width: 0; }
  .ps-val { font-size: 15px; font-weight: 700; color: var(--text-1); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .ps-label { font-size: 10px; font-weight: 600; color: var(--text-3); text-transform: uppercase; letter-spacing: 0.06em; }
  .ps-sep { width: 1px; height: 24px; background: var(--border); flex-shrink: 0; }

  /* Finish workout button — prominent end-of-list CTA */
  .finish-btn {
    display: flex; align-items: center; justify-content: center; gap: 8px;
    width: 100%; padding: 16px;
    background: linear-gradient(135deg, var(--accent), var(--accent-2));
    border: none; border-radius: var(--radius-lg);
    color: var(--accent-text, #fff); font-size: 15px; font-weight: 700;
    cursor: pointer;
    transition: transform var(--dur-fast), box-shadow var(--dur-fast);
    box-shadow: 0 4px 14px color-mix(in srgb, var(--accent) 35%, transparent);
    letter-spacing: 0.01em;
  }
  .finish-btn:hover { transform: translateY(-1px); box-shadow: 0 6px 18px color-mix(in srgb, var(--accent) 45%, transparent); }
  .finish-btn:active { transform: translateY(0) scale(0.99); }
  .finish-btn .material-symbols-rounded { font-size: 20px; }
  .finish-btn.reopen {
    background: var(--surface-1);
    color: var(--success);
    border: 1px solid var(--success);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--success) 18%, transparent);
  }
  .finish-text { flex: 1; text-align: left; }
  .finish-sub { font-size: 11px; font-weight: 500; opacity: 0.8; white-space: nowrap; }

  /* Drag-to-reorder wrapper (desktop — mobile uses the up/down arrows) */
  .drag-group { transition: opacity var(--dur-fast), transform var(--dur-fast); }
  .drag-group.dragging { opacity: 0.5; transform: scale(0.98); }
  .drag-group.drag-over {
    position: relative;
  }
  .drag-group.drag-over::before {
    content: '';
    position: absolute;
    left: 0; right: 0; top: -6px;
    height: 3px;
    background: linear-gradient(90deg, var(--accent), var(--accent-2));
    border-radius: var(--radius-full);
    box-shadow: 0 0 10px var(--accent-dim);
  }

  /* Per-exercise coach feedback inline below the card */
  .ex-feedback {
    display: flex; align-items: flex-start; gap: 6px;
    margin: 6px 0 4px;
    padding: 8px 10px;
    background: color-mix(in srgb, var(--accent) 8%, transparent);
    border-left: 3px solid var(--accent);
    border-radius: var(--radius-sm);
  }
  .ex-feedback-text { flex: 1; min-width: 0; font-size: 13px; color: var(--text-1); line-height: 1.4; white-space: pre-wrap; }
  .ex-feedback-text strong { color: var(--accent); font-weight: 700; margin-right: 2px; }
  .ex-feedback-target { color: var(--text-2); font-weight: 600; }
  :global(.ex-feedback-body) { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
  :global(.ex-feedback-time) { font-size: 11px; color: var(--text-3); }

  /* Reply controls — marked :global() so SupersetCard inherits them
     without re-declaring. Shared by per-exercise + workout-level UI. */
  :global(.reply-edit) { display: flex; flex-direction: column; gap: 6px; margin-top: 2px; }
  :global(.reply-input) {
    width: 100%;
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: var(--radius-sm); padding: 8px 10px;
    color: var(--text-1); font-size: 13px; font-family: inherit;
    outline: none; resize: vertical; min-height: 50px;
  }
  :global(.reply-input:focus) { border-color: var(--accent); }
  :global(.reply-actions) { display: flex; justify-content: flex-end; gap: 6px; align-items: center; }
  :global(.reply-link) {
    background: none; border: none; cursor: pointer;
    color: var(--text-2); font-size: 12px; font-weight: 600;
    padding: 4px 8px; border-radius: var(--radius-sm); font-family: inherit;
  }
  :global(.reply-link:hover) { color: var(--text-1); background: var(--surface-2); }
  :global(.reply-link.danger) { color: var(--danger); }
  :global(.reply-link.danger:hover) { background: color-mix(in srgb, var(--danger) 12%, transparent); }
  :global(.reply-save) {
    background: var(--accent); color: var(--accent-text);
    border: none; cursor: pointer;
    font-size: 12px; font-weight: 700;
    padding: 6px 12px; border-radius: var(--radius-sm); font-family: inherit;
  }
  :global(.reply-save:disabled) { opacity: 0.5; cursor: not-allowed; }
  :global(.reply-save.flashed),
  :global(.btn.flashed),
  :global(.wd-feedback-save.flashed) {
    background: var(--success) !important;
    color: white !important;
    transition: background 0.15s ease;
  }
  :global(.reply-save.flashed .material-symbols-rounded),
  :global(.btn.flashed .material-symbols-rounded),
  :global(.wd-feedback-save.flashed .material-symbols-rounded) {
    animation: check-pop 0.4s ease-out;
  }
  @keyframes check-pop {
    0% { transform: scale(0); }
    60% { transform: scale(1.2); }
    100% { transform: scale(1); }
  }
  :global(.reply-add) {
    display: inline-flex; align-items: center; gap: 4px;
    background: none; border: 1px dashed var(--border);
    color: var(--text-2); font-size: 12px; font-weight: 600;
    padding: 4px 10px; border-radius: var(--radius-sm); cursor: pointer;
    align-self: flex-start; font-family: inherit;
  }
  :global(.reply-add:hover) { color: var(--accent); border-color: var(--accent); }
  /* Member's reply bubble — right-aligned + accent-tinted so the coach
     note (left, accent border) + member reply read as a conversation
     instead of two stacked records. Indent from the left to leave
     room for the visual offset. */
  :global(.my-reply) {
    display: flex; align-items: center; gap: 6px;
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
    border-radius: var(--radius-md);
    border-bottom-right-radius: 4px;
    padding: 8px 12px;
    margin-left: 32px;  /* shifts the bubble right so it sits opposite the coach's note */
    font-size: 12px; color: var(--text-1);
    cursor: pointer; text-align: left; font-family: inherit;
  }
  :global(.my-reply-label) { font-weight: 700; color: var(--accent); flex-shrink: 0; }
  :global(.my-reply-text) { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  :global(.my-reply-edit-icon) { font-size: 14px; color: var(--text-3); flex-shrink: 0; }
  :global(.my-reply:hover) { background: color-mix(in srgb, var(--accent) 22%, transparent); }

  /* Diary header action — coach feedback inbox button + unread badge */
  .diary-header-action {
    margin-left: auto;
    position: relative;
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 6px 10px;
    color: var(--text-2); cursor: pointer;
    display: flex; align-items: center; gap: 4px;
  }
  .diary-header-action:hover { color: var(--accent); border-color: var(--accent); }
  /* Only the first .diary-header-action needs the margin-left:auto to
     push the button group to the right; subsequent siblings sit next
     to it with a small gap. */
  .diary-header-action ~ .diary-header-action { margin-left: 6px; }
  /* Accent variant for the Add-exercise header button so it reads as
     the primary action in the group; the Coach Feedback button stays
     in its default surface-2 look next to it. */
  .diary-header-add { color: var(--accent); }
  .diary-header-add:hover { background: var(--accent-dim); }
  .diary-header-action.dim { opacity: 0.55; }
  .diary-header-action.dim:hover { opacity: 1; }
  .diary-header-badge {
    background: var(--accent); color: white;
    font-size: 11px; font-weight: 700;
    padding: 1px 7px; border-radius: var(--radius-full);
    line-height: 1.4; min-width: 18px; text-align: center;
  }

  /* Coach feedback inbox sheet */
  .inbox-sheet { display: flex; flex-direction: column; gap: 4px; padding: 4px 0 12px; }
  .inbox-empty { padding: 24px; text-align: center; color: var(--text-3); font-size: 13px; }
  .inbox-toolbar { display: flex; justify-content: flex-end; padding: 0 8px 4px; }
  .btn-link {
    background: none; border: none; cursor: pointer;
    color: var(--accent); font-size: 12px; font-weight: 600;
    padding: 4px 8px; border-radius: var(--radius-sm);
  }
  .btn-link:hover { background: var(--accent-dim); }
  .inbox-row {
    display: flex; align-items: flex-start; gap: 10px;
    width: 100%; padding: 12px 14px;
    background: none; border: none; cursor: pointer; text-align: left;
    border-radius: var(--radius-md);
    transition: background var(--dur-fast);
  }
  .inbox-row:hover { background: var(--surface-2); }
  .inbox-row.unread { background: color-mix(in srgb, var(--accent) 8%, transparent); }
  .inbox-icon { color: var(--accent); font-size: 20px; flex-shrink: 0; margin-top: 2px; }
  .inbox-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .inbox-title { font-size: 13px; font-weight: 600; color: var(--text-1); }
  .inbox-note { font-size: 13px; color: var(--text-2); line-height: 1.35; white-space: pre-wrap; }
  .inbox-time { font-size: 11px; color: var(--text-3); }
  .inbox-dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: var(--accent); flex-shrink: 0; margin-top: 6px;
  }

  /* Calendar picker — unread coach-feedback dot rendered alongside the
     existing workout dot, but in the accent color to differentiate. */
  .dp-day { position: relative; }
  .dp-dot-feedback {
    background: var(--accent) !important;
    transform: translateX(8px);  /* sit next to the workout dot, not on top */
  }

  /* Avatar chip — small circular bubble used next to coach / member
     notes + replies so the conversation feels human, not system-y.
     :global() so SupersetCard renders with the same styling. */
  :global(.avatar-chip) {
    width: 28px; height: 28px;
    border-radius: 50%;
    display: inline-flex; align-items: center; justify-content: center;
    flex-shrink: 0;
    font-size: 12px; font-weight: 700;
    overflow: hidden;
    background: var(--accent-dim); color: var(--accent);
  }
  :global(.avatar-chip.sm) { width: 22px; height: 22px; font-size: 10px; }
  :global(.avatar-chip.coach) { background: var(--accent-dim); color: var(--accent); }
  :global(.avatar-chip.member) {
    background: color-mix(in srgb, var(--text-2) 18%, transparent);
    color: var(--text-2);
  }
  :global(.avatar-chip img) {
    width: 100%; height: 100%; object-fit: cover; border-radius: 50%;
  }

  /* Coach feedback banner (workout-level) */
  .coach-feedback-banner {
    display: flex; align-items: flex-start; gap: 12px;
    margin: 10px var(--page-px) 0;
    padding: 12px 14px;
    background: color-mix(in srgb, var(--accent) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
    border-radius: var(--radius-lg);
  }
  .coach-feedback-icon { font-size: 22px; color: var(--accent); flex-shrink: 0; margin-top: 1px; }
  .coach-feedback-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
  .coach-feedback-head {
    font-size: 12px; font-weight: 700; letter-spacing: 0.04em;
    text-transform: uppercase; color: var(--text-3);
    display: flex; align-items: center; gap: 4px; flex-wrap: wrap;
  }
  .coach-feedback-time { font-weight: 600; text-transform: none; letter-spacing: 0; }
  .coach-feedback-note { font-size: 14px; color: var(--text-1); line-height: 1.4; white-space: pre-wrap; }

  /* Suggested-by-coach undated prescriptions */
  .suggested-section {
    margin: 10px var(--page-px) 0;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    overflow: hidden;
  }
  .suggested-head {
    display: flex; align-items: center; gap: 8px;
    padding: 12px 14px;
    font-size: 12px; font-weight: 700; letter-spacing: 0.05em;
    text-transform: uppercase; color: var(--text-3);
    border-bottom: 1px solid var(--border);
  }
  .suggested-icon { font-size: 18px; color: var(--accent); }
  .suggested-row {
    display: flex; align-items: center; gap: 12px;
    width: 100%; padding: 12px 14px;
    background: none; border: none; cursor: pointer;
    text-align: left;
    border-bottom: 1px solid var(--border);
  }
  .suggested-row:last-child { border-bottom: none; }
  .suggested-row:hover { background: var(--surface-2); }
  .suggested-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .suggested-title { font-size: 14px; font-weight: 600; color: var(--text-1); }
  .suggested-sub { font-size: 12px; color: var(--text-3); }
  .suggested-chev { color: var(--text-3); flex-shrink: 0; }

  /* Coach prescription banner */
  .coach-banner {
    display: flex; align-items: center; gap: 12px;
    margin: 10px var(--page-px) 0;
    padding: 12px 14px;
    background: linear-gradient(135deg, var(--accent-dim), transparent);
    border: 1px solid var(--accent);
    border-radius: var(--radius-lg);
  }
  .coach-banner.loaded { border-color: var(--success); background: linear-gradient(135deg, color-mix(in srgb, var(--success) 14%, transparent), transparent); }
  .coach-icon { font-size: 22px; color: var(--accent); flex-shrink: 0; }
  .coach-banner.loaded .coach-icon { color: var(--success); }
  .coach-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .coach-title { font-size: 13px; color: var(--text-1); line-height: 1.4; }
  .coach-title strong { font-weight: 700; }
  .coach-notes { font-size: 12px; color: var(--text-3); line-height: 1.3; font-style: italic; }
  .coach-btn { height: 36px; padding: 0 16px; font-size: 13px; flex-shrink: 0; }
  .coach-loaded-chip {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 5px 10px; border-radius: var(--radius-full);
    background: color-mix(in srgb, var(--success) 16%, transparent);
    color: var(--success); font-size: 11px; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.04em; flex-shrink: 0;
  }

  .empty-state {
    text-align: center;
    padding: 48px 24px;
    color: var(--text-3);
  }
  .empty-icon { font-size: 56px; color: var(--accent-dim); display: block; margin: 0 auto 16px; }
  .empty-state h3 { font-size: 20px; font-weight: 700; color: var(--text-2); margin: 0 0 8px; }
  .empty-state p { font-size: 14px; margin: 0 0 20px; }
  .empty-actions { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; }
  .empty-actions button { display: flex; align-items: center; gap: 6px; padding: 12px 20px; font-size: 14px; }
  .empty-actions .material-symbols-rounded { font-size: 20px; }

  /* Quick-start cards on the empty state. Three cards stacked
     (active program / coach pick / last workout), each tappable and
     visually distinct from the manual Add Exercise / Smart Add buttons. */
  .quick-starts {
    width: 100%;
    display: flex; flex-direction: column; gap: 8px;
    margin: 8px 0 20px;
  }
  .quick-card {
    display: flex; flex-direction: column; gap: 4px;
    width: 100%; padding: 14px 16px;
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    cursor: pointer; text-align: left;
    transition: background var(--dur-fast), transform var(--dur-fast), border-color var(--dur-fast);
    font-family: inherit;
  }
  .quick-card:hover { background: var(--surface-2); border-color: var(--accent); }
  .quick-card:active { transform: scale(0.98); }
  .quick-card.coach { border-color: color-mix(in srgb, var(--accent) 30%, var(--border)); background: color-mix(in srgb, var(--accent) 4%, var(--surface-1)); }
  .qc-tag {
    font-size: 10px; font-weight: 700;
    letter-spacing: 0.06em; text-transform: uppercase;
    color: var(--accent);
  }
  .qc-title { font-size: 15px; font-weight: 700; color: var(--text-1); }
  .qc-meta  { font-size: 12px; color: var(--text-3); }

  .recent-section { width: 100%; margin-top: 20px; }
  .recent-label {
    font-size: 11px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.06em; color: var(--text-3);
    display: block; text-align: left; margin-bottom: 8px;
  }
  .recent-card {
    display: flex; align-items: center; justify-content: space-between;
    width: 100%; padding: 12px 14px;
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: var(--radius-md); cursor: pointer;
    text-align: left; margin-bottom: 6px;
    transition: background var(--dur-fast);
  }
  .recent-card:hover { background: var(--surface-2); }
  .recent-info { display: flex; flex-direction: column; gap: 2px; }
  .recent-name { font-size: 14px; font-weight: 600; color: var(--text-1); }
  .recent-meta { font-size: 12px; color: var(--text-3); }

  /* Cardio slot lives outside the workout container so it renders on
     rest days too. Uses the same horizontal padding (--page-px) the
     workout region uses so the cardio card always lines up with
     exercise cards left and right. Full viewport width otherwise —
     the earlier max-width cap caused inconsistent alignment against
     full-width exercise cards. */
  .cardio-slot {
    padding: 16px var(--page-px) 0;
    box-sizing: border-box;
  }

  .notes-card {
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: var(--radius-lg); padding: 12px;
  }
  .notes-input {
    width: 100%; background: none; border: none; color: var(--text-1);
    font-size: 14px; resize: none; outline: none; font-family: inherit;
  }
  .notes-input::placeholder { color: var(--text-3); }

  .notes-trigger {
    display: inline-flex; align-items: center; gap: 6px;
    width: fit-content; padding: 8px 14px;
    background: none; border: 1px dashed var(--border);
    border-radius: var(--radius-md);
    color: var(--text-3); font-size: 12px; font-weight: 600;
    cursor: pointer; font-family: inherit;
    transition: color var(--dur-fast), border-color var(--dur-fast);
    align-self: flex-start;
  }
  .notes-trigger:hover { color: var(--accent); border-color: var(--accent); }
  .notes-trigger .material-symbols-rounded { font-size: 16px; }

  /* FABs */
  .fab-group {
    position: fixed;
    bottom: calc(var(--nav-h) + var(--safe-bottom) + var(--mini-player-h, 0px) + 16px);
    right: 16px;
    display: flex; flex-direction: column; gap: 10px;
    z-index: 30;
  }
  /* When user has dragged to a custom spot, inline style takes over. The
     `.positioned` class strips the default bottom/right anchors so the
     inline left/top values apply cleanly. */
  .fab-group.positioned { bottom: auto; right: auto; }
  .fab {
    width: 56px; height: 56px;
    border-radius: 50%;
    border: none;
    display: flex; align-items: center; justify-content: center;
    box-shadow: var(--shadow-lg);
    cursor: grab;
    touch-action: none;
    user-select: none;
    -webkit-user-select: none;
    transition: transform var(--dur-fast) var(--ease-spring);
  }
  .fab:active { cursor: grabbing; }
  .fab:active { transform: scale(0.9); }
  .fab .material-symbols-rounded { font-size: 24px; }
  .fab-primary { background: var(--accent); color: var(--accent-text); }
  .fab-primary .material-symbols-rounded { font-size: 28px; }
  .fab-secondary {
    width: 44px; height: 44px;
    background: var(--surface-1); border: 1px solid var(--border);
    color: var(--accent);
  }
  .fab-secondary .material-symbols-rounded { font-size: 22px; }

  /* Load Workout sheet */
  .load-workout { padding: 4px 0 8px; }
  .lw-title { font-size: 20px; font-weight: 700; color: var(--text-1); margin: 0 0 16px; }

  .lw-programs {
    display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none;
    padding-bottom: 12px; margin-bottom: 4px;
  }
  .lw-programs::-webkit-scrollbar { display: none; }
  .lw-program-btn {
    display: flex; align-items: center; gap: 6px;
    white-space: nowrap; padding: 8px 16px;
    border-radius: var(--radius-full);
    background: var(--surface-2); border: 1px solid var(--border);
    color: var(--text-2); font-size: 13px; font-weight: 600;
    cursor: pointer; flex-shrink: 0;
    transition: all var(--dur-fast);
  }
  .lw-program-btn.active { background: var(--accent-dim); border-color: var(--accent); color: var(--accent); }
  .lw-active-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); }

  /* Current plan week + repeat/regress controls (issue #13) */
  .lw-week-bar {
    display: flex; align-items: center; gap: 8px;
    margin: 0 0 12px; padding: 6px 8px;
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-md);
  }
  .lw-week-label { flex: 1; text-align: center; font-size: 14px; font-weight: 700; color: var(--text-1); }
  .lw-week-nav {
    width: 32px; height: 32px; padding: 0; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center;
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: var(--radius-sm); color: var(--text-1); cursor: pointer;
  }
  .lw-week-nav:disabled { opacity: 0.35; cursor: default; }
  .lw-week-nav .material-symbols-rounded { font-size: 20px; }
  .lw-week-auto {
    flex-shrink: 0; padding: 6px 10px;
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: var(--radius-sm); color: var(--text-2);
    font-size: 12px; font-weight: 700; font-family: inherit; cursor: pointer;
  }
  .lw-week-auto:hover { color: var(--text-1); border-color: var(--text-3); }

  .lw-templates {
    display: flex; flex-direction: column; gap: 4px;
    max-height: 50dvh; overflow-y: auto;
  }
  /* Restored to original full-width single-button row. The earlier
     wrapper-with-sibling-info-button refactor introduced an intrinsic-
     width bug on desktop PWA where the row failed to stretch across
     the sheet panel. The info button now lives INSIDE the same flex
     row as a clickable badge — same visual placement, simpler layout. */
  .lw-template {
    display: flex; align-items: center; gap: 12px;
    padding: 12px;
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: var(--radius-md);
    cursor: pointer; width: 100%; text-align: left;
    transition: background var(--dur-fast);
  }
  .lw-template:hover { background: var(--surface-2); }
  .lw-template:active { transform: scale(0.99); }
  .lw-tpl-info-badge {
    flex-shrink: 0;
    width: 32px; height: 32px;
    border-radius: var(--radius-sm);
    display: flex; align-items: center; justify-content: center;
    color: var(--text-3);
    cursor: pointer;
    transition: background var(--dur-fast), color var(--dur-fast);
  }
  .lw-tpl-info-badge:hover {
    background: var(--surface-2); color: var(--accent);
  }
  .lw-tpl-info-badge .material-symbols-rounded { font-size: 20px; }
  .lw-tpl-num {
    width: 28px; height: 28px; border-radius: var(--radius-sm);
    background: var(--accent-dim); color: var(--accent);
    font-size: 12px; font-weight: 700;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
  }
  .lw-tpl-info { flex: 1; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .lw-tpl-name { font-size: 14px; font-weight: 600; color: var(--text-1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .lw-tpl-meta { font-size: 12px; color: var(--text-3); }
  .lw-tpl-arrow { color: var(--text-3); font-size: 20px; }

  .lw-loading, .lw-empty, .lw-hint { text-align: center; padding: 24px 16px; color: var(--text-3); font-size: 14px; }

  /* Template-info preview sheet (info-button → contents). */
  .tpl-info-body { padding: 4px 4px 12px; display: flex; flex-direction: column; gap: 12px; }
  .tpl-info-meta {
    font-size: 11px; font-weight: 700; letter-spacing: 0.08em;
    text-transform: uppercase; color: var(--text-3);
    padding: 0 4px;
  }
  .tpl-info-list { display: flex; flex-direction: column; gap: 4px; }
  .tpl-info-ss-header {
    display: flex; align-items: center; gap: 4px;
    font-size: 10px; font-weight: 700; letter-spacing: 0.08em;
    text-transform: uppercase; color: var(--accent);
    padding: 8px 8px 2px;
  }
  .tpl-info-row {
    display: flex; align-items: flex-start; gap: 10px;
    padding: 10px 12px;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
  }
  .tpl-info-row.in-superset { border-left: 3px solid var(--accent); }
  .tpl-info-row-num {
    flex-shrink: 0; width: 22px; height: 22px; border-radius: 50%;
    background: var(--accent-dim); color: var(--accent);
    font-size: 11px; font-weight: 700;
    display: flex; align-items: center; justify-content: center;
  }
  .tpl-info-row-text { flex: 1; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .tpl-info-row-name {
    font-size: 14px; font-weight: 600; color: var(--text-1);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .tpl-info-row-target {
    font-size: 12px; color: var(--text-3);
    font-variant-numeric: tabular-nums;
  }
  .tpl-info-row-notes {
    font-size: 11px; color: var(--text-3); font-style: italic;
  }
  .tpl-info-cta {
    width: 100%; height: 44px;
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    font-size: 14px; font-weight: 600;
    margin-top: 4px;
  }
  .tpl-info-cta:disabled { opacity: 0.5; cursor: default; }

  .spin { animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* ── Calendar date picker ────────────────────────────────────────── */
  .dp-backdrop { position: fixed; inset: 0; z-index: 200; background: rgba(0,0,0,0.5); display: flex; align-items: flex-end; }
  .dp-sheet { background: var(--surface-1); border-radius: var(--radius-xl) var(--radius-xl) 0 0; width: 100%; max-width: 600px; margin: 0 auto; padding-bottom: var(--safe-bottom); }
  .dp-handle { width: 36px; height: 4px; background: var(--border); border-radius: 2px; margin: 10px auto 0; }
  .dp-nav { display: flex; align-items: center; justify-content: space-between; padding: 12px 8px 8px; }
  .dp-nav-btn { color: var(--text-2); }
  .dp-nav-btn:disabled { opacity: 0.3; cursor: default; }
  .dp-month-year { display: flex; align-items: center; gap: 6px; }
  .dp-month-btn { font-size: 16px; font-weight: 700; color: var(--text-1); background: var(--surface-2); border: none; cursor: pointer; border-radius: var(--radius-sm); padding: 2px 8px; display: flex; align-items: center; transition: background var(--dur-fast); }
  .dp-month-btn:hover { background: var(--surface-3); }
  .dp-year-btn { font-size: 16px; font-weight: 700; color: var(--accent); background: var(--accent-dim); border: none; cursor: pointer; border-radius: var(--radius-sm); padding: 2px 8px; display: flex; align-items: center; transition: background var(--dur-fast); }
  .dp-year-btn:hover { background: color-mix(in srgb, var(--accent) 20%, transparent); }
  .dp-year-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; padding: 4px 8px 8px; max-height: 220px; overflow-y: auto; }
  .dp-yr-btn { padding: 8px 4px; font-size: 14px; font-weight: 500; border-radius: var(--radius-sm); background: none; border: none; cursor: pointer; color: var(--text-1); transition: background var(--dur-fast); text-align: center; }
  .dp-yr-btn:hover { background: var(--surface-2); }
  .dp-yr-btn.dp-yr-sel { background: var(--accent); color: #fff; font-weight: 700; }
  .dp-month-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; padding: 4px 8px 8px; }
  .dp-mo-btn { padding: 10px 4px; font-size: 14px; font-weight: 500; border-radius: var(--radius-sm); background: none; border: none; cursor: pointer; color: var(--text-1); transition: background var(--dur-fast); text-align: center; }
  .dp-mo-btn:hover { background: var(--surface-2); }
  .dp-mo-btn.dp-mo-sel { background: var(--accent); color: #fff; font-weight: 700; }
  .dp-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; padding: 0 8px 4px; }
  .dp-dh { text-align: center; font-size: 11px; font-weight: 600; color: var(--text-3); padding: 4px 0; }
  .dp-day { aspect-ratio: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; font-size: 14px; border-radius: var(--radius-full); background: none; border: none; cursor: pointer; color: var(--text-1); transition: background var(--dur-fast); -webkit-tap-highlight-color: transparent; position: relative; }
  .dp-day:hover:not(:disabled) { background: var(--surface-2); }
  .dp-day.dp-today { color: var(--accent); font-weight: 700; }
  .dp-day.dp-sel { background: var(--accent) !important; color: #fff; font-weight: 600; }
  .dp-dot { width: 4px; height: 4px; border-radius: 50%; background: var(--accent); flex-shrink: 0; }
  .dp-day.dp-sel .dp-dot { background: #fff; }

  /* ── Superset picker ─────────────────────────────────────────────── */
  .ss-picker-body { display: flex; flex-direction: column; gap: 12px; padding: 8px 0 16px; }
  .ss-picker-hint { font-size: 13px; color: var(--text-3); margin: 0; }
  .ss-option {
    display: flex; align-items: center; gap: 12px; width: 100%;
    padding: 12px 14px; background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-md); cursor: pointer; text-align: left;
    transition: all var(--dur-fast);
  }
  .ss-option:hover { background: var(--accent-dim); border-color: var(--accent); }
  .ss-option-icon { color: var(--accent); font-size: 20px; }
  .ss-option-info { flex: 1; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .ss-option-count { font-size: 13px; font-weight: 600; color: var(--text-1); }
  .ss-option-names { font-size: 12px; color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ss-pick-list { display: flex; flex-direction: column; gap: 4px; max-height: 40vh; overflow-y: auto; }
  .ss-pick-row {
    display: flex; align-items: center; gap: 10px;
    padding: 10px 12px; background: var(--surface-2); border-radius: var(--radius-md);
    cursor: pointer; transition: background var(--dur-fast);
  }
  .ss-pick-row:hover { background: var(--surface-3); }
  .ss-pick-row input[type=checkbox] { width: 18px; height: 18px; accent-color: var(--accent); cursor: pointer; }
  .ss-pick-name { font-size: 14px; color: var(--text-1); }
  .ss-confirm { width: 100%; height: 44px; justify-content: center; margin-top: 4px; }

  /* Planning badge for future-date workouts */
  .planning-badge {
    display: flex; align-items: center; gap: 8px;
    margin: 12px var(--page-px) 0;
    padding: 10px 14px;
    background: var(--accent-dim);
    border: 1px solid var(--accent);
    border-radius: var(--radius-md);
    font-size: 13px; font-weight: 500; color: var(--accent);
  }
  .planning-badge .material-symbols-rounded { font-size: 18px; }

  /* ────────────────────────────────────────────────────────────────
     Diary large-screen layout (>=1280px, non-forced-mobile).

     Phase 1 shell: three-column grid — session HUD (left, summary +
     now-strip), main content (center, exercise list + banners +
     notes + cardio), program context (right, active-program +
     today's plan + session stats + Load Workout).

     Mobile default: .diary-body is a plain block; the right rail is
     display:none; DOM order is unchanged so summary-bar / coach-
     banner / workout-title / now-strip / exercise-list stack exactly
     as before.

     The whole desktop grid is opt-out via the existing
     force-mobile-layout toggle (Settings → Appearance → "Force
     Mobile Layout") so a user on a wide screen can revert to the
     phone-shaped diary if they prefer it.
     ──────────────────────────────────────────────────────────────── */

  /* Rail hidden by default on mobile — its content lives only on the
     desktop shell. Rail-card styles are shared so the same tokens
     work if we ever expose the rail on tablet later. */
  .diary-right-rail { display: none; }
  .rail-edge-tab    { display: none; }
  .rail-title       { display: none; }
  .hud-title        { display: none; }
  .hud-empty-card   { display: none; }
  .hud-notes-card   { display: none; }
  .hud-finish-btn   { display: none; }
  .rail-card {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .rail-card-head {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--text-1);
    font-weight: 600;
    font-size: 13px;
  }
  .rail-card-head .material-symbols-rounded {
    font-size: 18px;
    color: var(--accent);
  }
  .rail-card-title { flex: 1; min-width: 0; }
  .rail-card-meta {
    font-size: 12px;
    color: var(--text-3);
  }
  .rail-card-count {
    font-size: 11px;
    font-weight: 600;
    color: var(--text-3);
    padding: 2px 6px;
    background: var(--surface-2);
    border-radius: 999px;
  }
  /* 7-day peek: dow letter on top, day-of-month, then completion dot.
     Today gets a subtle ring; completed days fill the dot with accent. */
  .rail-week-strip {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 4px;
  }
  .rail-week-day {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
    padding: 6px 2px 5px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 6px;
    cursor: pointer;
    color: var(--text-2);
    transition: background var(--dur-fast), border-color var(--dur-fast);
  }
  .rail-week-day:hover { background: var(--surface-2); }
  .rail-week-day.today { border-color: color-mix(in srgb, var(--accent) 55%, transparent); }
  .rail-week-day.done  { color: var(--text-1); }
  .rail-week-dow {
    font-size: 10px;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--text-3);
  }
  .rail-week-dom { font-size: 13px; font-weight: 600; }
  .rail-week-dot {
    width: 6px; height: 6px; border-radius: 50%;
    background: var(--surface-2);
    border: 1px solid var(--border);
  }
  .rail-week-dot.on {
    background: var(--accent);
    border-color: var(--accent);
  }
  /* Recent workouts list — three most-recent completed sessions. */
  .rail-recent-list { display: flex; flex-direction: column; gap: 2px; }
  .rail-recent-row {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 6px 8px;
    margin: 0 -8px;
    background: transparent;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    text-align: left;
    transition: background var(--dur-fast);
  }
  .rail-recent-row:hover { background: var(--surface-2); }
  .rail-recent-date {
    font-size: 11px;
    color: var(--text-3);
    min-width: 44px;
    flex-shrink: 0;
  }
  .rail-recent-name {
    font-size: 13px;
    color: var(--text-1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    flex: 1;
  }
  .rail-card-body { display: flex; flex-direction: column; gap: 4px; }
  .rail-plan-name { font-size: 14px; font-weight: 500; color: var(--text-1); }
  .rail-plan-sub  { font-size: 12px; color: var(--text-3); }
  .rail-stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(60px, 1fr));
    gap: 8px;
    margin-top: 2px;
  }
  .rail-stat {
    display: flex;
    flex-direction: column;
    gap: 2px;
    align-items: flex-start;
  }
  .rail-stat-val {
    font-size: 18px;
    font-weight: 700;
    color: var(--text-1);
    line-height: 1.1;
  }
  .rail-stat-div {
    font-size: 13px;
    font-weight: 500;
    color: var(--text-3);
  }
  .rail-stat-label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-3);
  }
  .rail-action {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 10px 14px;
    background: color-mix(in srgb, var(--accent) 15%, transparent);
    color: var(--accent);
    border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
    border-radius: var(--radius-md);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: background var(--dur-fast);
  }
  .rail-action:hover { background: color-mix(in srgb, var(--accent) 25%, transparent); }
  .rail-action .material-symbols-rounded { font-size: 18px; }

  @media (min-width: 1280px) {
    /* Three-column shell. Two wrapper divs (.diary-hud-col and
       .diary-main-col) plus the .diary-right-rail sibling are the
       three grid children — each is a single cell so heights don't
       bleed between columns. */
    :global(html:not(.force-mobile-layout)) .diary-body {
      display: grid;
      /* Center takes all remaining width — the earlier max-width:1440px
         cap centred the grid and left dead margins on wide monitors.
         Center's own content (exercise-list) still reads well because
         individual cards inside cap themselves at their component
         level; letting the column grow just kills the outer margins. */
      grid-template-columns: 280px minmax(720px, 1fr) 340px;
      gap: 24px;
      align-items: start;
      padding: 0 var(--page-px);
      box-sizing: border-box;
    }
    /* Left column — session HUD wrapper. Sticks with the user as the
       center column scrolls so the timer + now-doing stay visible. */
    :global(html:not(.force-mobile-layout)) .diary-body > .diary-hud-col {
      grid-column: 1;
      display: flex;
      flex-direction: column;
      gap: 10px;
      position: sticky;
      top: calc(var(--page-top, var(--safe-top)) + 130px + var(--hamburger-row, 0px));
      align-self: start;
    }
    :global(html:not(.force-mobile-layout)) .diary-body > .diary-hud-col > .summary-bar,
    :global(html:not(.force-mobile-layout)) .diary-body > .diary-hud-col > .now-strip {
      margin: 0;
      width: 100%;
    }
    /* HUD title — mirrors the right rail's .rail-title look so the
       two columns read as one system. */
    :global(html:not(.force-mobile-layout)) .diary-body > .diary-hud-col > .hud-title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 0 4px 4px;
    }
    :global(html:not(.force-mobile-layout)) .diary-body > .diary-hud-col > .hud-title > .hud-title-text {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--text-3);
    }
    /* Summary-bar becomes a proper vertical HUD card in the left
       column — stat grid on top, timer + wake-lock as a footer row.
       Uses the same surface + border tokens the rail cards use so
       the left column visually matches the right. */
    :global(html:not(.force-mobile-layout)) .diary-body > .diary-hud-col > .summary-bar {
      display: grid;
      grid-template-columns: 1fr 1fr;
      grid-auto-rows: min-content;
      gap: 14px 12px;
      align-items: start;
      padding: 14px;
      background: var(--surface-1);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
    }
    :global(html:not(.force-mobile-layout)) .diary-body > .diary-hud-col > .summary-bar > .sb-fill {
      /* Hide the horizontal fill sliver in the vertical HUD layout —
         the sets stat below already communicates progress. */
      display: none;
    }
    :global(html:not(.force-mobile-layout)) .diary-body > .diary-hud-col > .summary-bar > .stat {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 2px;
      min-width: 0;
    }
    :global(html:not(.force-mobile-layout)) .diary-body > .diary-hud-col > .summary-bar > .stat > .stat-icon {
      display: none;
    }
    :global(html:not(.force-mobile-layout)) .diary-body > .diary-hud-col > .summary-bar > .stat > .stat-val {
      font-size: 20px;
      font-weight: 700;
      line-height: 1.1;
      color: var(--text-1);
    }
    :global(html:not(.force-mobile-layout)) .diary-body > .diary-hud-col > .summary-bar > .stat > .stat-label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--text-3);
      display: inline;
    }
    /* Timer + wake-lock as a footer row spanning both columns. */
    :global(html:not(.force-mobile-layout)) .diary-body > .diary-hud-col > .summary-bar > :global(.workout-timer) {
      grid-column: 1 / -1;
      justify-self: start;
    }
    :global(html:not(.force-mobile-layout)) .diary-body > .diary-hud-col > .summary-bar > .wake-toggle {
      grid-column: 1 / -1;
      justify-self: end;
      margin-top: -32px;
    }
    /* Center column — the actual training content. Plain flex stack. */
    :global(html:not(.force-mobile-layout)) .diary-body > .diary-main-col {
      grid-column: 2;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 0;
    }
    /* Kill the page-px horizontal padding on center-col children —
       the grid gap already handles spacing. Otherwise every card
       is double-padded and drifts right. */
    :global(html:not(.force-mobile-layout)) .diary-body > .diary-main-col > .exercise-list,
    :global(html:not(.force-mobile-layout)) .diary-body > .diary-main-col > .cardio-slot {
      padding-left: 0;
      padding-right: 0;
    }
    :global(html:not(.force-mobile-layout)) .diary-body > .diary-main-col > .workout-title-row,
    :global(html:not(.force-mobile-layout)) .diary-body > .diary-main-col > .coach-banner,
    :global(html:not(.force-mobile-layout)) .diary-body > .diary-main-col > .coach-feedback-banner,
    :global(html:not(.force-mobile-layout)) .diary-body > .diary-main-col > .suggested-section,
    :global(html:not(.force-mobile-layout)) .diary-body > .diary-main-col > .cardio-slot,
    :global(html:not(.force-mobile-layout)) .diary-body > .diary-main-col > .planning-badge {
      margin-left: 0;
      margin-right: 0;
    }
    /* When the rail is hidden via _railMode, drop the third column
       so the center column reclaims that width. The rail aside itself
       is not rendered in hidden mode. */
    :global(html:not(.force-mobile-layout)) .diary-body.rail-hidden {
      grid-template-columns: 280px minmax(0, 1fr);
    }
    /* Right column — program context rail. Pinned mode is portaled
       to document.body so position:fixed resolves against the viewport
       (not against .page-transition, which has will-change:transform
       and breaks fixed positioning for descendants). JS keeps the
       aside aligned to the grid column via --diary-rail-top /
       --diary-rail-left / --diary-rail-width set on the aside itself
       (custom properties don't inherit across a portal). Grid still
       reserves the 340px column because its track size is explicit,
       so the center column doesn't reflow when the aside leaves flow. */
    :global(html:not(.force-mobile-layout)) .diary-right-rail {
      display: flex;
      flex-direction: column;
      gap: 12px;
      position: fixed;
      top: calc(var(--page-top, var(--safe-top)) + var(--diary-rail-top, 130px) + var(--hamburger-row, 0px));
      left: var(--diary-rail-left, auto);
      width: var(--diary-rail-width, 340px);
      z-index: 5;
      max-height: calc(100vh
        - var(--page-top, var(--safe-top))
        - var(--diary-rail-top, 130px)
        - 10px
        - var(--hamburger-row, 0px)
        - var(--nav-h, 0px)
        - var(--safe-bottom, 0px));
      overflow-y: auto;
      scrollbar-width: thin;
      scrollbar-color: var(--border) transparent;
      padding-right: 4px;
    }
    :global(html:not(.force-mobile-layout)) .diary-right-rail::-webkit-scrollbar { width: 8px; }
    :global(html:not(.force-mobile-layout)) .diary-right-rail::-webkit-scrollbar-track { background: transparent; }
    :global(html:not(.force-mobile-layout)) .diary-right-rail::-webkit-scrollbar-thumb {
      background: var(--border);
      border-radius: var(--radius-full);
    }
    :global(html:not(.force-mobile-layout)) .diary-right-rail::-webkit-scrollbar-thumb:hover { background: var(--text-3); }
    /* Widgets keep natural size; rail scrolls internally when the
       stack exceeds max-height. :global(*) because widget component
       roots (BodyStatsWidget, GymTools) don't carry Diary's scoping
       hash, so an un-globalized `> *` would miss. */
    :global(html:not(.force-mobile-layout)) .diary-right-rail > :global(*) { flex-shrink: 0; }
    /* Overlay variant: same widget stack, positioned as a fixed
       slide-in on the viewport's right edge instead of tracking the
       grid column. Sits above page content, doesn't dim the
       background (widgets are additive, not a modal task). */
    :global(html:not(.force-mobile-layout)) .diary-right-rail-overlay {
      top: calc(var(--page-top, var(--safe-top)) + 60px + var(--hamburger-row, 0px));
      right: 12px;
      bottom: 12px;
      left: auto;
      width: 380px;
      max-width: calc(100vw - 24px);
      z-index: 40;
      background: var(--surface-1);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      box-shadow: 0 20px 50px -20px rgba(0,0,0,0.35);
      padding: 12px;
      overflow-y: auto;
      max-height: none;
      align-self: auto;
      animation: rail-slide-in 200ms ease-out;
    }
    @keyframes rail-slide-in {
      from { transform: translateX(24px); opacity: 0; }
      to   { transform: translateX(0);    opacity: 1; }
    }
    @media (prefers-reduced-motion: reduce) {
      :global(html:not(.force-mobile-layout)) .diary-right-rail-overlay { animation: none; }
    }
    /* Rail title bar — tiny "Overview" label + collapse button that
       drops the rail into the fixed edge tab. Sits above the first
       card in the sticky column. */
    /* Rail title bar — matches NT verbatim so both apps read as one
       system. Tiny "Overview" label on the left; pin/hide/close
       controls on the right. */
    :global(html:not(.force-mobile-layout)) .rail-title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 2px 4px 4px;
    }
    :global(html:not(.force-mobile-layout)) .rail-title-text {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-3);
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    :global(html:not(.force-mobile-layout)) .rail-title-actions {
      display: flex;
      gap: 2px;
    }
    :global(html:not(.force-mobile-layout)) .rail-ctrl-btn {
      background: transparent;
      border: 1px solid transparent;
      border-radius: var(--radius-full);
      width: 22px;
      height: 22px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: var(--text-3);
      cursor: pointer;
      padding: 0;
      transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
    }
    :global(html:not(.force-mobile-layout)) .rail-ctrl-btn:hover {
      background: var(--surface-2);
      color: var(--text-1);
      border-color: var(--border);
    }
    :global(html:not(.force-mobile-layout)) .rail-ctrl-btn .material-symbols-rounded { font-size: 16px; }
    /* Desktop empty-state card in the left HUD column. */
    :global(html:not(.force-mobile-layout)) .diary-body > .diary-hud-col > .hud-empty-card {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 8px;
      padding: 16px 14px;
      background: var(--surface-1);
      border: 1px dashed var(--border);
      border-radius: var(--radius-md);
    }
    :global(html:not(.force-mobile-layout)) .diary-body > .diary-hud-col > .hud-empty-card > .hud-empty-icon {
      font-size: 22px;
      color: var(--accent);
      opacity: 0.85;
    }
    :global(html:not(.force-mobile-layout)) .diary-body > .diary-hud-col > .hud-empty-card > .hud-empty-title {
      margin: 0;
      font-size: 13px;
      font-weight: 700;
      color: var(--text-1);
    }
    :global(html:not(.force-mobile-layout)) .diary-body > .diary-hud-col > .hud-empty-card > .hud-empty-desc {
      margin: 0;
      font-size: 12px;
      color: var(--text-3);
      line-height: 1.4;
    }
    :global(html:not(.force-mobile-layout)) .diary-body > .diary-hud-col > .hud-empty-card > .rail-action {
      align-self: stretch;
      margin-top: 4px;
    }

    /* Desktop session-notes card in the left HUD column. Mirrors
       rail-card visual tokens for consistency with the right rail. */
    :global(html:not(.force-mobile-layout)) .diary-body > .diary-hud-col > .hud-notes-card {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 12px 14px;
      background: var(--surface-1);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
    }
    :global(html:not(.force-mobile-layout)) .diary-body > .diary-hud-col > .hud-notes-card > .hud-notes-head {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      font-weight: 600;
      color: var(--text-1);
    }
    :global(html:not(.force-mobile-layout)) .diary-body > .diary-hud-col > .hud-notes-card > .hud-notes-head > .material-symbols-rounded {
      font-size: 18px;
      color: var(--accent);
    }
    :global(html:not(.force-mobile-layout)) .diary-body > .diary-hud-col > .hud-notes-card > .hud-notes-input {
      width: 100%;
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 8px 10px;
      color: var(--text-1);
      font-family: inherit;
      font-size: 13px;
      line-height: 1.4;
      resize: vertical;
      min-height: 72px;
    }
    :global(html:not(.force-mobile-layout)) .diary-body > .diary-hud-col > .hud-notes-card > .hud-notes-input::placeholder {
      color: var(--text-3);
    }
    /* Suppress the in-list day-notes affordances at wide widths so
       the notes card is single-source (the HUD copy above). Same
       for the in-list finish button — the HUD copy above is now
       the desktop entry point so it stays reachable without
       scrolling past the last exercise. */
    :global(html:not(.force-mobile-layout)) .diary-body .exercise-list :global(.notes-card),
    :global(html:not(.force-mobile-layout)) .diary-body .exercise-list :global(.notes-trigger),
    :global(html:not(.force-mobile-layout)) .diary-body .exercise-list :global(.finish-btn) {
      display: none;
    }
    /* HUD finish button — accent-tinted CTA that mirrors the mobile
       .finish-btn's role. Same reopen (task_alt) affordance for
       already-completed sessions. */
    :global(html:not(.force-mobile-layout)) .diary-body > .diary-hud-col > .hud-finish-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      flex-wrap: wrap;
      padding: 12px 14px;
      background: var(--accent);
      color: var(--surface-1);
      border: 1px solid var(--accent);
      border-radius: var(--radius-md);
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: filter var(--dur-fast), transform var(--dur-fast);
    }
    :global(html:not(.force-mobile-layout)) .diary-body > .diary-hud-col > .hud-finish-btn:hover {
      filter: brightness(1.08);
    }
    :global(html:not(.force-mobile-layout)) .diary-body > .diary-hud-col > .hud-finish-btn:active {
      transform: scale(0.99);
    }
    :global(html:not(.force-mobile-layout)) .diary-body > .diary-hud-col > .hud-finish-btn.reopen {
      background: transparent;
      color: var(--accent);
    }
    :global(html:not(.force-mobile-layout)) .diary-body > .diary-hud-col > .hud-finish-btn .material-symbols-rounded {
      font-size: 20px;
    }
    :global(html:not(.force-mobile-layout)) .diary-body > .diary-hud-col > .hud-finish-btn > .hud-finish-sub {
      flex-basis: 100%;
      text-align: center;
      font-size: 11px;
      font-weight: 500;
      opacity: 0.85;
      margin-top: -2px;
    }

    /* Hide the portaled top-right icon strip at wide widths — the
       right rail's Tools group now carries these three actions
       (Gym Tools / Body Stats / More). Mirrors NT's diary pattern
       of dropping mobile top surfaces when the rail owns them. */
    :global(html:not(.force-mobile-layout)) :global(.diary-topbar-actions) {
      display: none;
    }
    /* Hide the bottom-right FAB stack on wide viewports — the Add
       button now lives inline in the page header (.diary-header-add),
       and the FAB overlaps the pinned rail column (and gets covered
       outright by the overlay, which sits at z-index 40). */
    :global(html:not(.force-mobile-layout)) .fab-group {
      display: none;
    }
    /* Workout Actions rail card — inline action rows instead of the
       old hamburger launcher. Each row is a full-width button that
       matches .rail-action's visual weight but slimmer, so the card
       reads as a cluster of secondary actions and doesn't compete
       with Load Workout above it. */
    :global(html:not(.force-mobile-layout)) .rail-actions-card { gap: 6px; }
    :global(html:not(.force-mobile-layout)) .rail-actions-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    :global(html:not(.force-mobile-layout)) .rail-action-row {
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      padding: 8px 10px;
      background: transparent;
      border: 1px solid transparent;
      border-radius: var(--radius-sm);
      color: var(--text-2);
      font-size: 13px;
      font-family: inherit;
      text-align: left;
      cursor: pointer;
      transition: background var(--dur-fast), color var(--dur-fast), border-color var(--dur-fast);
    }
    :global(html:not(.force-mobile-layout)) .rail-action-row:hover {
      background: var(--surface-2);
      color: var(--text-1);
      border-color: var(--border);
    }
    :global(html:not(.force-mobile-layout)) .rail-action-row .material-symbols-rounded {
      font-size: 18px;
      color: var(--accent);
      flex-shrink: 0;
    }
    :global(html:not(.force-mobile-layout)) .rail-action-row-label { flex: 1; min-width: 0; }
    /* Danger variant for Clear Workout so destruction reads distinctly
       from the reversible actions above it. */
    :global(html:not(.force-mobile-layout)) .rail-action-row.danger { color: var(--danger); }
    :global(html:not(.force-mobile-layout)) .rail-action-row.danger .material-symbols-rounded { color: var(--danger); }
    :global(html:not(.force-mobile-layout)) .rail-action-row.danger:hover {
      background: color-mix(in srgb, var(--danger) 12%, transparent);
      border-color: color-mix(in srgb, var(--danger) 40%, transparent);
      color: var(--danger);
    }

    /* ExerciseCard 2-col split at wide widths. Header + target-info
       span full width; .last-row (previous session) sits in the left
       context column while .sets-wrap (the actual set entry) takes
       the right main column. This is the phase-3 workout-specific
       win: "last time" comparison always at eye level next to the
       fields you're typing into, so progressive overload becomes
       visible instead of a memory game.

       Scoped to .ex-card.standalone (the class ExerciseCard sets
       when NOT inside a superset) so nested ex-cards inside a
       SupersetCard keep their linear layout — the .ss-connector
       + narrower nested container makes a 2-col grid there squish
       badly. */
    :global(html:not(.force-mobile-layout)) .diary-body .exercise-list :global(.ex-card.standalone) {
      display: grid;
      grid-template-columns: minmax(200px, 260px) 1fr;
      column-gap: 20px;
      align-items: start;
    }
    :global(html:not(.force-mobile-layout)) .diary-body .exercise-list :global(.ex-card.standalone > .ex-header) {
      grid-column: 1 / -1;
    }
    :global(html:not(.force-mobile-layout)) .diary-body .exercise-list :global(.ex-card.standalone > .last-row) {
      grid-column: 1;
      /* When the row is a standalone card cell, drop the linear-
         gradient background — it was designed to run edge-to-edge
         across a full-width card, looks stripey inside a narrow col.
         Keep the dashed top border as a divider. */
      background: none;
      /* Vertical breathing room since it sits alone in a column. */
      padding: 10px 14px 12px;
      /* Restack the last-row from an inline strip into a compact
         column so each previous set gets its own line — much more
         scannable when it sits next to the sets grid. */
      flex-direction: column;
      align-items: stretch;
      gap: 6px;
    }
    :global(html:not(.force-mobile-layout)) .diary-body .exercise-list :global(.ex-card.standalone > .last-row > .last-label) {
      font-size: 10px;
      color: var(--text-3);
    }
    /* Convert the horizontal .last-sets strip into a per-set list.
       CSS counter labels each row "Set N" so users can match rows
       one-for-one with the sets grid on the right without any
       markup changes to ExerciseCard. */
    :global(html:not(.force-mobile-layout)) .diary-body .exercise-list :global(.ex-card.standalone > .last-row > .last-sets) {
      display: flex;
      flex-direction: column;
      gap: 3px;
      counter-reset: last-set-counter;
      width: 100%;
    }
    :global(html:not(.force-mobile-layout)) .diary-body .exercise-list :global(.ex-card.standalone > .last-row > .last-sets > .last-set) {
      counter-increment: last-set-counter;
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      padding: 2px 0;
      font-variant-numeric: tabular-nums;
    }
    :global(html:not(.force-mobile-layout)) .diary-body .exercise-list :global(.ex-card.standalone > .last-row > .last-sets > .last-set::before) {
      content: "Set " counter(last-set-counter);
      color: var(--text-3);
      font-weight: 500;
      font-size: 11px;
    }
    :global(html:not(.force-mobile-layout)) .diary-body .exercise-list :global(.ex-card.standalone > .last-row > .last-sets > .last-sep) {
      display: none;
    }
    :global(html:not(.force-mobile-layout)) .diary-body .exercise-list :global(.ex-card.standalone > .last-row > .vol-delta) {
      margin-left: 0;
      align-self: flex-start;
      margin-top: 4px;
    }
    :global(html:not(.force-mobile-layout)) .diary-body .exercise-list :global(.ex-card.standalone > .sets-wrap) {
      grid-column: 2;
    }
    :global(html:not(.force-mobile-layout)) .diary-body .exercise-list :global(.ex-card.standalone > .target-info) {
      grid-column: 1 / -1;
    }
    /* Empty-card fallback: when the card has NO .last-row (fresh
       exercise, no prior history), the grid still reserves col 1 —
       leaving dead space next to a lonely .sets-wrap. Cap the sets
       column so the layout doesn't look weirdly offset. */
    :global(html:not(.force-mobile-layout)) .diary-body .exercise-list :global(.ex-card.standalone:not(:has(.last-row))) {
      grid-template-columns: 1fr;
    }
    :global(html:not(.force-mobile-layout)) .diary-body .exercise-list :global(.ex-card.standalone:not(:has(.last-row)) > .sets-wrap) {
      grid-column: 1;
    }

    /* Fixed edge tab — appears when the rail is hidden. Half-round
       chip anchored to the right viewport edge, vertically centered.
       Same sticky-top math so it sits below the header. */
    /* Right-edge tab — small vertical chevron button pinned to the
       viewport's right side, visible only in hidden mode. Matches NT
       verbatim so the two apps read as one system. */
    :global(html:not(.force-mobile-layout)) .rail-edge-tab {
      position: fixed;
      right: 0;
      top: 50%;
      transform: translateY(-50%);
      width: 24px;
      height: 56px;
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-right: none;
      border-top-left-radius: var(--radius-md);
      border-bottom-left-radius: var(--radius-md);
      color: var(--text-2);
      cursor: pointer;
      padding: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      z-index: 41;
      transition: background 120ms ease, color 120ms ease, width 120ms ease;
    }
    :global(html:not(.force-mobile-layout)) .rail-edge-tab:hover {
      background: var(--surface-3);
      color: var(--text-1);
      width: 28px;
    }
    :global(html:not(.force-mobile-layout)) .rail-edge-tab .material-symbols-rounded { font-size: 18px; }
  }
</style>
