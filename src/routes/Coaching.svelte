<script>
  import { onMount } from 'svelte';
  import { push } from 'svelte-spa-router';
  import { _ } from 'svelte-i18n';
  import { LtApi } from '../lib/api.js';
  import { currentUser } from '../stores/auth.js';
  import { showError, showSuccess } from '../stores/toast.js';
  import { confirmDialog } from '../stores/confirmDialog.js';
  import Sheet from '../components/ui/Sheet.svelte';
  import DateInput from '../components/ui/DateInput.svelte';
  import CoachTabs from '../components/layout/CoachTabs.svelte';
  import CoachingBanner from '../components/banners/CoachingBanner.svelte';
  import { pageBanners, bannerStyle } from '../stores/settings.js';
  import { resolveAssetUrl } from '../lib/platform.js';

  export let params = {};

  $: memberId = params.memberId ? parseInt(params.memberId) : null;

  let members = [];
  let loadingList = true;

  // Recent coach activity feed — completions + missed prescriptions across
  // all of this trainer's members. Drives the "Recent activity" section on
  // the members list and unread badges on each member card.
  let activity = [];
  $: unseenActivityIds = activity.filter(a => !a.seen_at).map(a => a.id);
  $: unreadByMember = (() => {
    const map = {};
    for (const a of activity) if (!a.seen_at) map[a.member_id] = (map[a.member_id] || 0) + 1;
    return map;
  })();

  let overview = null;
  let prescriptions = [];
  let loadingOverview = false;

  // Prescribe sheet state
  let showPrescribe = false;
  let pxDate = '';
  let pxTemplateId = null;
  let pxNotes = '';
  let pxPrograms = [];  // coach's programs + member's assigned programs
  let pxSaving = false;

  // Assign-program sheet state (in-place: scoped to current memberId)
  let showAssignProgram = false;
  let assignablePrograms = [];
  let assignProgramId = null;
  let assignStartDate = '';
  let assignMakeActive = true;
  let assigning = false;

  // Add-coachee sheet (claim an unassigned member from the pool)
  let showAddCoachee = false;
  let unassignedMembers = [];
  let claiming = false;

  // Edit-prescription sheet (change date / notes after creation)
  let showEditPrescription = false;
  let editingPxId = null;
  let editPxDate = '';
  let editPxNotes = '';
  let editPxSaving = false;

  async function loadMembers() {
    loadingList = true;
    try { members = await LtApi.getMyMembers(); }
    catch(e) { showError(e.message); members = []; }
    loadingList = false;
  }

  async function loadActivity() {
    try { activity = await LtApi.getCoachActivity(50); }
    catch { activity = []; }
  }

  async function markActivitySeen(id) {
    try {
      await LtApi.markCoachActivitySeen(id);
      activity = activity.map(a => a.id === id ? { ...a, seen_at: new Date().toISOString() } : a);
    } catch {}
  }

  async function markAllActivitySeen() {
    if (unseenActivityIds.length === 0) return;
    try {
      await LtApi.markCoachActivitySeen();
      activity = activity.map(a => ({ ...a, seen_at: a.seen_at || new Date().toISOString() }));
    } catch {}
  }

  function activityLabel(a) {
    const tpl = a.template_name || a.prescription_name || 'a workout';
    if (a.kind === 'prescription_completed') return `completed ${tpl}`;
    if (a.kind === 'prescription_missed')    return `missed ${tpl} on ${a.prescription_date}`;
    if (a.kind === 'feedback_reply') {
      const text = a.feedback_reply_text || '';
      const max = 80;
      const trimmed = text.length > max ? text.slice(0, max - 1) + '…' : text;
      return trimmed ? `replied: "${trimmed}"` : 'replied to your note';
    }
    return a.kind;
  }

  function activityIcon(a) {
    if (a.kind === 'prescription_completed') return 'check_circle';
    if (a.kind === 'prescription_missed')    return 'error';
    if (a.kind === 'feedback_reply')         return 'reply';
    return 'notifications';
  }

  function activityColor(a) {
    if (a.kind === 'prescription_completed') return 'var(--success)';
    if (a.kind === 'prescription_missed')    return 'var(--danger)';
    if (a.kind === 'feedback_reply')         return 'var(--accent)';
    return 'var(--text-3)';
  }

  function activityRelative(occurred) {
    if (!occurred) return '';
    const then = new Date(occurred).getTime();
    const diff = Date.now() - then;
    const mins = Math.round(diff / 60000);
    if (mins < 60) return mins <= 1 ? 'just now' : `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.round(hrs / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(occurred).toLocaleDateString();
  }
  // Alias used by the coach's read-receipt + reply-time labels. Same shape.
  const relTime = activityRelative;

  async function removeCoachee() {
    if (!memberId || !overview?.user) return;
    const name = memberLabel(overview.user);
    if (!await confirmDialog({
      title: 'Release coachee?',
      message: `Remove ${name} from your coaching roster? Their account stays — you'll just no longer be their coach, and any prescriptions or program assignments you've given them will be removed.`,
      confirmText: 'Release',
      dangerous: true,
    })) return;
    try {
      await LtApi.removeCoachee(memberId);
      showSuccess(`${name} released from your roster`);
      push('/coaching');
    } catch(e) { showError(e.message); }
  }

  async function setActiveProgramForMember(programId, programName) {
    if (!memberId) return;
    try {
      // Re-use the assign endpoint with make_active=true; on the server this
      // deactivates the member's other assignments and activates this one.
      // Idempotent if the row already exists (ON CONFLICT DO UPDATE).
      await LtApi.assignProgram(programId, { user_id: memberId, make_active: true });
      showSuccess(`${programName} is now ${memberLabel(overview?.user)}'s active program`);
      await loadOverview(memberId);
    } catch(e) { showError(e.message); }
  }

  // Workout-detail sheet — coach taps a row in Recent workouts, we open this
  // sheet with the full exercise list + set breakdown plus editable coach
  // feedback (workout-level note + per-exercise notes).
  let showWorkoutDetail = false;
  let workoutDetailLoading = false;
  let workoutDetail = null;
  // Local working copies of feedback so the coach can type, then save.
  // workoutNote holds the workout-level draft; exerciseNotes is keyed by
  // POSITION INDEX in the workout's exercises array so two slots that
  // reference the same library exercise stay independent.
  let workoutNote = '';
  let exerciseNotes = {};
  let savingFeedback = null; // null | 'workout' | <exercise_idx>
  let editingExerciseIdx = null;
  // Workout-level editor is collapsed by default. Auto-expands when there's
  // an existing note from the current trainer (so the coach can edit it
  // immediately on open) or when the coach taps "Add a note".
  let workoutEditorOpen = false;

  // Svelte action — focus on mount. Used on every feedback / reply
  // textarea so opening one immediately becomes typeable (no extra tap
  // on the field itself).
  function autofocus(node) { setTimeout(() => node.focus(), 0); return {}; }
  // Brief checkmark state after a successful save — replaces the spinner
  // with a satisfying ✓ for ~900ms so the coach gets a visual close-out
  // beyond just the toast.
  let savedFlash = null;
  function flashSaved(key) {
    savedFlash = key;
    setTimeout(() => { if (savedFlash === key) savedFlash = null; }, 900);
  }

  async function openWorkoutDetail(w) {
    showWorkoutDetail = true;
    workoutDetailLoading = true;
    workoutDetail = null;
    workoutNote = '';
    exerciseNotes = {};
    editingExerciseIdx = null;
    try {
      const res = await fetch(`/api/trainer/members/${memberId}/workout/${w.date}`, { credentials: 'include' });
      if (!res.ok) throw new Error('Could not load workout');
      workoutDetail = await res.json();
      const mine = (workoutDetail?.feedback || []).filter(f => f.trainer_id === $currentUser?.id);
      const wl = mine.find(f => f.exercise_idx == null);
      if (wl) workoutNote = wl.note || '';
      // Only show the workout-level editor expanded when there's already a
      // note to edit; otherwise show the compact "+ Add" CTA so the sheet
      // doesn't carry visual weight for unused affordances.
      workoutEditorOpen = !!wl;
      for (const f of mine) {
        if (f.exercise_idx != null) exerciseNotes[f.exercise_idx] = f.note || '';
      }
      exerciseNotes = exerciseNotes; // trigger reactivity
    } catch(e) { showError(e.message); }
    workoutDetailLoading = false;
  }

  async function saveWorkoutFeedback() {
    if (!workoutDetail) return;
    savingFeedback = 'workout';
    try {
      await LtApi.saveCoachFeedback({
        workout_id: workoutDetail.id,
        exercise_idx: null,
        note: workoutNote,
      });
      showSuccess(workoutNote?.trim() ? 'Feedback saved' : 'Feedback removed');
      flashSaved('workout');
      const res = await fetch(`/api/trainer/members/${memberId}/workout/${workoutDetail.date}`, { credentials: 'include' });
      if (res.ok) workoutDetail = await res.json();
    } catch(e) { showError(e.message); }
    savingFeedback = null;
  }

  async function deleteWorkoutFeedback() {
    if (!workoutDetail) return;
    if (!await confirmDialog({
      title: 'Delete this note?',
      message: 'Your workout-level feedback for this session will be removed.',
      confirmText: 'Delete',
      dangerous: true,
    })) return;
    workoutNote = '';
    await saveWorkoutFeedback();
  }

  async function saveExerciseFeedback(idx) {
    if (!workoutDetail || idx == null) return;
    savingFeedback = idx;
    try {
      await LtApi.saveCoachFeedback({
        workout_id: workoutDetail.id,
        exercise_idx: idx,
        note: exerciseNotes[idx] || '',
      });
      showSuccess((exerciseNotes[idx] || '').trim() ? 'Note saved' : 'Note removed');
      flashSaved(idx);
      editingExerciseIdx = null;
      const res = await fetch(`/api/trainer/members/${memberId}/workout/${workoutDetail.date}`, { credentials: 'include' });
      if (res.ok) workoutDetail = await res.json();
    } catch(e) { showError(e.message); }
    savingFeedback = null;
  }

  async function deleteExerciseFeedback(idx) {
    if (!workoutDetail || idx == null) return;
    if (!await confirmDialog({
      title: 'Delete this note?',
      message: 'Your note on this exercise will be removed.',
      confirmText: 'Delete',
      dangerous: true,
    })) return;
    exerciseNotes[idx] = '';
    await saveExerciseFeedback(idx);
  }

  function feedbackForExerciseIdx(idx) {
    return (workoutDetail?.feedback || []).filter(f => f.exercise_idx === idx);
  }
  function workoutLevelFeedback() {
    return (workoutDetail?.feedback || []).filter(f => f.exercise_idx == null);
  }

  async function unassignProgram(programId, programName) {
    if (!memberId) return;
    if (!await confirmDialog({
      title: 'Remove program?',
      message: `Remove ${programName} from ${memberLabel(overview?.user)}'s assigned programs?`,
      confirmText: 'Remove',
      dangerous: true,
    })) return;
    try {
      await LtApi.unassignProgram(programId, memberId);
      showSuccess('Program removed');
      await loadOverview(memberId);
    } catch(e) { showError(e.message); }
  }

  async function loadOverview(id) {
    loadingOverview = true;
    overview = null;
    prescriptions = [];
    try {
      overview = await LtApi.getMemberOverview(id);
      prescriptions = await LtApi.getMemberPrescriptions(id);
    } catch(e) { showError(e.message); }
    loadingOverview = false;
  }

  async function openPrescribe() {
    // Pull the coach's programs + whatever is assigned to the member so they can pick a template
    try {
      const all = await LtApi.getPrograms();
      // Fetch templates for each program lazily. For simplicity here, fetch detail for all.
      const detailed = [];
      for (const p of all) {
        try {
          const full = await LtApi.getProgram(p.id);
          detailed.push({ ...p, templates: full.templates || [] });
        } catch {}
      }
      pxPrograms = detailed.filter(p => (p.templates || []).length > 0);
    } catch(e) { showError(e.message); }
    pxDate = '';
    pxTemplateId = null;
    pxNotes = '';
    showPrescribe = true;
  }

  async function savePrescription() {
    if (!pxTemplateId) { showError('Pick a workout template'); return; }
    pxSaving = true;
    try {
      await LtApi.createPrescription(memberId, {
        template_id: pxTemplateId,
        date: pxDate || null,
        notes: pxNotes || null,
      });
      showSuccess('Workout prescribed');
      showPrescribe = false;
      prescriptions = await LtApi.getMemberPrescriptions(memberId);
    } catch(e) { showError(e.message); }
    pxSaving = false;
  }

  async function openAssignProgram() {
    try {
      assignablePrograms = await LtApi.getPrograms();
    } catch(e) { showError(e.message); assignablePrograms = []; }
    assignProgramId = null;
    assignStartDate = '';
    assignMakeActive = true;
    showAssignProgram = true;
  }

  async function confirmAssignProgram() {
    if (!assignProgramId || !memberId) { showError('Pick a program'); return; }
    assigning = true;
    try {
      await LtApi.assignProgram(assignProgramId, {
        user_id: memberId,
        start_date: assignStartDate || null,
        make_active: assignMakeActive,
      });
      const p = assignablePrograms.find(x => x.id === assignProgramId);
      showSuccess(
        assignMakeActive
          ? `Assigned ${p?.name || 'program'} to ${memberLabel(overview?.user)}`
          : `${p?.name || 'Program'} added to ${memberLabel(overview?.user)}'s library`
      );
      showAssignProgram = false;
      await loadOverview(memberId);
    } catch(e) { showError(e.message); }
    assigning = false;
  }

  async function openAddCoachee() {
    try { unassignedMembers = await LtApi.getUnassignedMembers(); }
    catch(e) { showError(e.message); unassignedMembers = []; }
    showAddCoachee = true;
  }

  async function claimCoachee(uId) {
    if (claiming) return;
    claiming = true;
    try {
      await LtApi.claimCoachee(uId);
      const m = unassignedMembers.find(x => x.id === uId);
      showSuccess(`${memberLabel(m)} added to your roster`);
      showAddCoachee = false;
      await Promise.all([loadMembers(), loadActivity()]);
    } catch(e) { showError(e.message); }
    claiming = false;
  }

  function openEditPrescription(p) {
    editingPxId = p.id;
    editPxDate = p.date || '';
    editPxNotes = p.notes || '';
    showEditPrescription = true;
  }

  async function saveEditPrescription() {
    if (editPxSaving || !editingPxId) return;
    editPxSaving = true;
    try {
      await LtApi.updatePrescription(editingPxId, {
        date: editPxDate || null,
        notes: editPxNotes || null,
      });
      showSuccess('Prescription updated');
      showEditPrescription = false;
      prescriptions = await LtApi.getMemberPrescriptions(memberId);
    } catch(e) { showError(e.message); }
    editPxSaving = false;
  }

  async function deletePrescription(id) {
    if (!await confirmDialog({ title: 'Remove prescription?', message: 'The member will no longer see this prescription in their diary.', confirmText: 'Remove', dangerous: true })) return;
    try {
      await LtApi.deletePrescription(id);
      prescriptions = prescriptions.filter(p => p.id !== id);
      showSuccess('Prescription removed');
    } catch(e) { showError(e.message); }
  }

  onMount(async () => {
    await Promise.all([loadMembers(), loadActivity()]);
  });

  $: if (memberId) loadOverview(memberId).then(() => {
    // Activity-feed deep-link: an activity row stashed { memberId, date }
    // in sessionStorage just before navigating here. If it matches the
    // member we just loaded, open the workout detail sheet automatically
    // so the coach lands directly on the reply they were notified about.
    try {
      const raw = sessionStorage.getItem('coaching_open_workout');
      if (!raw) return;
      const { memberId: m, date } = JSON.parse(raw);
      sessionStorage.removeItem('coaching_open_workout');
      if (m === memberId && date) openWorkoutDetail({ date });
    } catch {}
  });

  function fmtDate(d) {
    if (!d) return 'No specific day';
    return new Date(d + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }

  function memberLabel(u) {
    return u?.full_name || u?.nickname || u?.username || '?';
  }

  function initials(u) {
    return (memberLabel(u) || '?')[0].toUpperCase();
  }

  function relDate(d) {
    if (!d) return 'never';
    const date = new Date(d + 'T12:00:00');
    const today = new Date(); today.setHours(0,0,0,0);
    const diff = Math.round((today - date) / (1000*60*60*24));
    if (diff === 0) return 'today';
    if (diff === 1) return 'yesterday';
    if (diff < 7) return `${diff}d ago`;
    if (diff < 30) return `${Math.round(diff/7)}w ago`;
    return date.toLocaleDateString();
  }
</script>

{#if !memberId}
  <!-- ══════════ My Members list ══════════ -->
  <div class="page">
    <header class="page-header" class:has-banner={$pageBanners} class:banner-gradient={$bannerStyle === 'gradient'}>
      {#if $bannerStyle === 'animated'}<CoachingBanner />{/if}
      <h1>{$_('routes.coaching.title')}</h1>
      <div class="header-actions">
        <button class="btn-primary-sm" on:click={openAddCoachee} title="Add a coachee">
          <span class="material-symbols-rounded">person_add</span>
          Add
        </button>
      </div>
    </header>

    <CoachTabs />

    <div class="content">
      {#if activity.length > 0}
        <section class="block activity-block">
          <div class="block-head">
            <h3 class="block-title">
              Recent Activity
              {#if unseenActivityIds.length > 0}
                <span class="unread-pill">{unseenActivityIds.length}</span>
              {/if}
            </h3>
            {#if unseenActivityIds.length > 0}
              <button class="btn-link" on:click={markAllActivitySeen}>Mark all seen</button>
            {/if}
          </div>
          {#each activity.slice(0, 6) as a (a.id)}
            <button class="list-row activity-row" class:unread={!a.seen_at}
              on:click={() => {
                markActivitySeen(a.id);
                // feedback_reply rows know the workout date — stash it in
                // sessionStorage so the member overview auto-opens the
                // workout detail sheet on mount, saving the coach two
                // taps (find the workout in Recent, then tap it).
                if (a.kind === 'feedback_reply' && a.workout_date) {
                  try { sessionStorage.setItem('coaching_open_workout', JSON.stringify({ memberId: a.member_id, date: a.workout_date })); } catch {}
                }
                push(`/coaching/${a.member_id}`);
              }}>
              <span class="material-symbols-rounded row-icon"
                    style:color={activityColor(a)}>{activityIcon(a)}</span>
              <div class="row-body">
                <span class="row-title">
                  {a.member_full_name || a.member_username || `Member #${a.member_id}`}
                  <span class="row-action">{activityLabel(a)}</span>
                </span>
                <span class="row-sub">{activityRelative(a.occurred_at)}</span>
              </div>
              {#if !a.seen_at}<span class="unread-dot" aria-hidden="true"></span>{/if}
            </button>
          {/each}
        </section>
      {/if}

      {#if loadingList}
        <div class="empty">Loading…</div>
      {:else if members.length === 0}
        <div class="empty">
          <span class="material-symbols-rounded empty-icon">groups</span>
          <p class="empty-title">No members yet</p>
          <p class="empty-hint">An admin can assign members to you from Settings → User Management.</p>
        </div>
      {:else}
        {#each members as m (m.id)}
          <button class="member-card" on:click={() => push(`/coaching/${m.id}`)}>
            <div class="avatar-wrap">
              <div class="avatar">
                {#if m.avatar_url}
                  <img src={resolveAssetUrl(m.avatar_url)} alt="" class="avatar-img" />
                {:else}
                  {initials(m)}
                {/if}
              </div>
              {#if unreadByMember[m.id]}
                <span class="avatar-badge">{unreadByMember[m.id]}</span>
              {/if}
            </div>
            <div class="member-info">
              <span class="member-name">{memberLabel(m)}</span>
              <span class="member-sub">
                {#if m.active_program}<span class="tag">{m.active_program}</span>{/if}
                <span class="muted">Last: {relDate(m.last_workout_date)}</span>
                <span class="muted">· {m.week_count} this week</span>
              </span>
            </div>
            <span class="material-symbols-rounded chev">chevron_right</span>
          </button>
        {/each}
      {/if}
    </div>
  </div>
{:else}
  <!-- ══════════ Member Overview ══════════ -->
  <div class="page">
    <header class="page-header">
      <button class="back-btn" on:click={() => push('/coaching')} aria-label="Back">
        <span class="material-symbols-rounded">arrow_back</span>
      </button>
      <h1>{overview ? memberLabel(overview.user) : 'Member'}</h1>
      {#if overview}
        <button class="btn-icon danger header-action" on:click={removeCoachee}
                title="Release coachee" aria-label="Release coachee">
          <span class="material-symbols-rounded">person_remove</span>
        </button>
      {/if}
    </header>

    <div class="content">
      {#if loadingOverview}
        <div class="empty">Loading…</div>
      {:else if !overview}
        <div class="empty">Couldn't load member.</div>
      {:else}
        <!-- Summary card -->
        <div class="card summary-card">
          <div class="summary-row">
            <div class="stat">
              <span class="stat-val">{overview.streak}</span>
              <span class="stat-label">Day streak</span>
            </div>
            <div class="stat">
              <span class="stat-val">{overview.recent_workouts.filter(w => w.completed).length}</span>
              <span class="stat-label">Recent workouts</span>
            </div>
            <div class="stat">
              <span class="stat-val">{overview.active_program?.name ?? '—'}</span>
              <span class="stat-label">Active program</span>
            </div>
          </div>
        </div>

        <!-- Programs -->
        <section class="block">
          <div class="block-head">
            <h3 class="block-title">Programs</h3>
            <button class="btn btn-primary sm" on:click={openAssignProgram}>
              <span class="material-symbols-rounded" style="font-size:14px">add</span>
              Assign program
            </button>
          </div>
          {#if overview.assigned_programs.length === 0}
            <div class="empty-inline">No programs assigned yet.</div>
          {:else}
            {#each overview.assigned_programs as p (p.id)}
              <div class="list-row">
                <span class="material-symbols-rounded row-icon">calendar_month</span>
                <div class="row-body">
                  <span class="row-title">{p.name}</span>
                  <span class="row-sub">{p.goal || 'general'}</span>
                </div>
                {#if p.active}
                  <span class="badge active-badge">Active</span>
                {:else}
                  <button class="btn-icon-sm" on:click={() => setActiveProgramForMember(p.id, p.name)} title="Make active" aria-label="Make active">
                    <span class="material-symbols-rounded">play_arrow</span>
                  </button>
                {/if}
                <button class="btn-icon-sm danger" on:click={() => unassignProgram(p.id, p.name)} title="Remove program" aria-label="Remove program">
                  <span class="material-symbols-rounded">close</span>
                </button>
              </div>
            {/each}
          {/if}
        </section>

        <!-- Prescribed workouts -->
        <section class="block">
          <div class="block-head">
            <h3 class="block-title">Prescribed workouts</h3>
            <button class="btn btn-primary sm" on:click={openPrescribe}>
              <span class="material-symbols-rounded" style="font-size:14px">add</span>
              Prescribe
            </button>
          </div>
          {#if prescriptions.length === 0}
            <div class="empty-inline">Nothing prescribed yet.</div>
          {:else}
            {#each prescriptions as p (p.id)}
              <div class="list-row" class:px-done={p.completed === 1}>
                <span class="material-symbols-rounded row-icon"
                      style:color={p.completed === 1 ? 'var(--success)' : 'var(--accent)'}>
                  {p.completed === 1 ? 'check_circle' : 'assignment'}
                </span>
                <div class="row-body">
                  <span class="row-title">
                    {p.template_name || p.name || 'Custom workout'}
                    {#if p.program_name}<span class="muted-sep">· {p.program_name}</span>{/if}
                  </span>
                  <span class="row-sub">
                    {fmtDate(p.date)}
                    {#if p.completed === 1} · <span style="color:var(--success)">Completed</span>{/if}
                    {#if p.completed === 0 && p.date && p.date < new Date().toISOString().slice(0,10)} · <span style="color:var(--danger)">Missed</span>{/if}
                    {#if p.notes} · {p.notes}{/if}
                  </span>
                </div>
                <button class="btn-icon-sm" on:click={() => openEditPrescription(p)} title="Edit" aria-label="Edit prescription">
                  <span class="material-symbols-rounded">edit</span>
                </button>
                <button class="btn-icon-sm danger" on:click={() => deletePrescription(p.id)} title="Remove">
                  <span class="material-symbols-rounded">close</span>
                </button>
              </div>
            {/each}
          {/if}
        </section>

        <!-- Recent workouts -->
        <section class="block">
          <div class="block-head">
            <h3 class="block-title">Recent workouts</h3>
          </div>
          {#if overview.recent_workouts.length === 0}
            <div class="empty-inline">No completed workouts yet.</div>
          {:else}
            {#each overview.recent_workouts as w (w.id)}
              <button class="list-row workout-row" on:click={() => openWorkoutDetail(w)}>
                <span class="material-symbols-rounded row-icon" style:color="var(--success)">check_circle</span>
                <div class="row-body">
                  <span class="row-title">{w.name || 'Workout'}</span>
                  <span class="row-sub">
                    {new Date(w.date + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
                    {#if w.exercise_count} · {w.exercise_count} {w.exercise_count === 1 ? 'exercise' : 'exercises'}{/if}
                    {#if w.set_count} · {w.set_count} sets{/if}
                    {#if w.duration_min} · {Math.round(w.duration_min)}m{/if}
                  </span>
                </div>
                <!-- Feedback at-a-glance: comment icon when this coach has
                     left a note, with a reply badge if the member responded.
                     A faint icon shows when ANY coach has a note (handoff
                     case) but the current coach hasn't. -->
                {#if w.my_feedback_count > 0}
                  <span class="workout-feedback-marker" class:has-reply={w.my_reply_count > 0}
                        title={w.my_reply_count > 0 ? 'Member replied to your note' : 'You left a note'}>
                    <span class="material-symbols-rounded">{w.my_reply_count > 0 ? 'mark_unread_chat_alt' : 'comment'}</span>
                  </span>
                {:else if w.feedback_count > 0}
                  <span class="workout-feedback-marker faint" title="Another coach has a note">
                    <span class="material-symbols-rounded">comment</span>
                  </span>
                {/if}
                {#if w.volume > 0}
                  <span class="workout-volume">{w.volume.toLocaleString()} {overview?.weight_unit || 'lbs'}</span>
                {/if}
                <span class="material-symbols-rounded chev">chevron_right</span>
              </button>
            {/each}
          {/if}
        </section>
      {/if}
    </div>
  </div>
{/if}

<!-- Assign Program Sheet — pre-scoped to the current memberId so the
     assignment lands on the right user without a separate member-picker step. -->
<Sheet open={showAssignProgram} on:close={() => showAssignProgram = false} title="Assign a program">
  <div class="prescribe-sheet">
    <p class="hint">Pick one of your programs to assign to <strong>{memberLabel(overview?.user)}</strong>.</p>

    <div class="field">
      <label>Program</label>
      {#if assignablePrograms.length === 0}
        <p class="empty-inline">Create a program first to assign one.</p>
      {:else}
        <select class="form-input" bind:value={assignProgramId}>
          <option value={null}>— choose a program —</option>
          {#each assignablePrograms as p (p.id)}
            <option value={p.id}>{p.name}</option>
          {/each}
        </select>
      {/if}
    </div>

    <div class="field">
      <label>Start date (optional)</label>
      <DateInput bind:value={assignStartDate} />
    </div>

    <label class="checkbox-row">
      <input type="checkbox" bind:checked={assignMakeActive} />
      <span>
        <span class="cb-label">Make this their active program</span>
        <span class="cb-hint">Off = added to their library; they can switch to it themselves later</span>
      </span>
    </label>

    <div class="form-actions">
      <button class="btn btn-secondary" on:click={() => showAssignProgram = false}>Cancel</button>
      <button class="btn btn-primary" on:click={confirmAssignProgram} disabled={assigning || !assignProgramId}>
        {assigning ? 'Assigning…' : 'Assign'}
      </button>
    </div>
  </div>
</Sheet>

<!-- Add Coachee Sheet — claim an unassigned member from the pool. -->
<Sheet open={showAddCoachee} on:close={() => showAddCoachee = false} title="Add a coachee">
  <div class="prescribe-sheet">
    {#if unassignedMembers.length === 0}
      <p class="empty-inline">No unassigned members available. Members without a coach show up here; admins can also reassign members from Settings → User Management.</p>
    {:else}
      <p class="hint">Pick a member to add to your coaching roster:</p>
      {#each unassignedMembers as m (m.id)}
        <button class="assign-row" on:click={() => claimCoachee(m.id)} disabled={claiming}>
          <div class="avatar">
            {#if m.avatar_url}
              <img src={resolveAssetUrl(m.avatar_url)} alt="" class="avatar-img" />
            {:else}
              {initials(m)}
            {/if}
          </div>
          <div class="info">
            <span class="name">{memberLabel(m)}</span>
            <span class="sub">@{m.username}</span>
          </div>
          <span class="material-symbols-rounded chev">chevron_right</span>
        </button>
      {/each}
    {/if}
  </div>
</Sheet>

<!-- Workout Detail Sheet — read-only view of a member's completed workout
     with editable coach feedback (workout-level + per-exercise notes). -->
<Sheet open={showWorkoutDetail} on:close={() => showWorkoutDetail = false}
       title={workoutDetail?.name || 'Workout'}>
  <div class="workout-detail">
    {#if workoutDetailLoading}
      <div class="empty-inline">Loading…</div>
    {:else if !workoutDetail}
      <div class="empty-inline">Couldn't load this workout.</div>
    {:else}
      {@const unit = overview?.weight_unit || 'lbs'}
      {@const totalVolume = (workoutDetail.exercises || []).reduce((sum, ex) => {
        const lt = ex.load_type || 'bilateral';
        return sum + (ex.sets || []).filter(s => s.completed && !s.warmup).reduce((a, s) => {
          const w = s.weight || 0;
          if (lt === 'unilateral') {
            if (s.reps_l != null || s.reps_r != null) return a + w * ((s.reps_l || 0) + (s.reps_r || 0));
            return a + w * (s.reps || 0) * 2;
          }
          if (lt === 'paired') return a + w * (s.reps || 0) * 2;
          return a + w * (s.reps || 0);
        }, 0);
      }, 0)}
      <div class="wd-summary">
        <div class="wd-stat"><span class="wd-stat-val">{new Date(workoutDetail.date + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</span><span class="wd-stat-label">Date</span></div>
        <div class="wd-stat"><span class="wd-stat-val">{workoutDetail.duration_min ? Math.round(workoutDetail.duration_min) + 'm' : '—'}</span><span class="wd-stat-label">Duration</span></div>
        <div class="wd-stat">
          <span class="wd-stat-val">{Math.round(totalVolume).toLocaleString()}</span>
          <span class="wd-stat-label">Volume ({unit})</span>
        </div>
      </div>

      {#if workoutDetail.notes}
        <div class="wd-notes">
          <span class="material-symbols-rounded" style="font-size:16px;color:var(--text-3)">sticky_note_2</span>
          <span>{workoutDetail.notes}</span>
        </div>
      {/if}

      <!-- Coach's workout-level feedback editor. Collapsed to a single
           CTA when empty; expands inline when the coach taps it or when
           a note already exists. -->
      <div class="wd-feedback">
        {#if !workoutEditorOpen}
          <button class="wd-add-workout-note" on:click={() => workoutEditorOpen = true}>
            <span class="material-symbols-rounded" style="font-size:16px">add_comment</span>
            Add a note on this workout
          </button>
        {:else}
          <div class="wd-feedback-head">
            <span class="material-symbols-rounded" style="font-size:16px;color:var(--accent)">comment</span>
            <span>Note for {memberLabel(overview?.user)}</span>
          </div>
          <textarea class="wd-feedback-input" rows="2"
            use:autofocus
            bind:value={workoutNote}
            placeholder="Form, intensity, what to push next…"></textarea>
          <div class="wd-feedback-actions">
            {#if workoutLevelFeedback().some(f => f.trainer_id === $currentUser?.id)}
              <button class="btn btn-secondary wd-feedback-save danger"
                      on:click={deleteWorkoutFeedback}
                      disabled={savingFeedback === 'workout'}>
                Delete
              </button>
            {/if}
            <button class="btn btn-secondary wd-feedback-save"
                    on:click={() => { workoutEditorOpen = !!workoutNote?.trim(); }}>
              Cancel
            </button>
            <button class="btn btn-primary wd-feedback-save" class:flashed={savedFlash === 'workout'}
                    on:click={saveWorkoutFeedback}
                    disabled={savingFeedback === 'workout' || !workoutNote?.trim()}>
              {#if savedFlash === 'workout'}<span class="material-symbols-rounded" style="font-size:16px">check</span>{:else}{savingFeedback === 'workout' ? 'Saving…' : 'Save note'}{/if}
            </button>
          </div>
        {/if}
        <!-- Read receipt + reply for the current trainer's own
             workout-level note. seen_by_member_at fires when the member
             taps Reply or opens this note in the inbox. -->
        {#each workoutLevelFeedback().filter(f => f.trainer_id === $currentUser?.id) as f}
          {#if f.seen_by_member_at && !f.member_reply}
            <div class="wd-receipt">
              <span class="material-symbols-rounded" style="font-size:13px">done_all</span>
              Seen by {memberLabel(overview?.user)} · {relTime(f.seen_by_member_at)}
            </div>
          {/if}
          {#if f.member_reply}
            <div class="wd-reply">
              <div class="avatar-chip member sm">
                {#if overview?.user?.avatar_url}
                  <img src={resolveAssetUrl(overview.user.avatar_url)} alt="" />
                {:else}
                  {initials(overview?.user)}
                {/if}
              </div>
              <div class="wd-reply-body">
                <span class="wd-reply-label">
                  {memberLabel(overview?.user)} replied
                  {#if f.member_replied_at} · {relTime(f.member_replied_at)}{/if}
                </span>
                <span class="wd-reply-text">{f.member_reply}</span>
              </div>
            </div>
          {/if}
        {/each}
        {#each workoutLevelFeedback().filter(f => f.trainer_id !== $currentUser?.id) as f}
          <div class="wd-feedback-other">
            <span class="wd-feedback-author">{f.trainer_name}:</span>
            <span>{f.note}</span>
          </div>
        {/each}
      </div>

      {#each (workoutDetail.exercises || []) as ex, idx}
        {@const done = (ex.sets || []).filter(s => s.completed)}
        {#if done.length > 0}
          {@const exFb = feedbackForExerciseIdx(idx)}
          {@const myFb = exFb.find(f => f.trainer_id === $currentUser?.id)}
          {@const isEditing = editingExerciseIdx === idx}
          <div class="wd-exercise">
            <div class="wd-ex-head">
              <span class="wd-ex-name">{ex.exercise_name}</span>
              <span class="wd-ex-count">{done.length} {done.length === 1 ? 'set' : 'sets'}</span>
            </div>
            <div class="wd-sets">
              {#each done as s, i}
                <div class="wd-set" class:warmup={s.warmup}>
                  <span class="wd-set-n">{i + 1}{s.warmup ? ' (w)' : ''}</span>
                  <span class="wd-set-detail">{s.weight || 0} {unit} × {s.reps || 0}</span>
                  {#if s.rpe != null}<span class="wd-set-rpe">@ {s.rpe}</span>{/if}
                </div>
              {/each}
            </div>
            {#if ex.notes}
              <div class="wd-ex-notes">{ex.notes}</div>
            {/if}
            {#if isEditing}
              <div class="wd-ex-feedback-edit">
                <textarea class="wd-feedback-input" rows="2"
                  use:autofocus
                  bind:value={exerciseNotes[idx]}
                  placeholder={`Note on ${ex.exercise_name}…`}></textarea>
                <div class="wd-feedback-actions">
                  {#if myFb}
                    <button class="btn btn-secondary danger" on:click={() => deleteExerciseFeedback(idx)}
                            disabled={savingFeedback === idx}>
                      Delete
                    </button>
                  {/if}
                  <button class="btn btn-secondary" on:click={() => editingExerciseIdx = null}>Cancel</button>
                  <button class="btn btn-primary" class:flashed={savedFlash === idx}
                          on:click={() => saveExerciseFeedback(idx)}
                          disabled={savingFeedback === idx || !(exerciseNotes[idx] || '').trim()}>
                    {#if savedFlash === idx}<span class="material-symbols-rounded" style="font-size:16px">check</span>{:else}{savingFeedback === idx ? 'Saving…' : 'Save'}{/if}
                  </button>
                </div>
              </div>
            {:else if myFb}
              <button class="wd-ex-feedback-mine" on:click={() => editingExerciseIdx = idx}>
                <span class="material-symbols-rounded" style="font-size:14px;color:var(--accent)">comment</span>
                <span class="wd-ex-feedback-text">{myFb.note}</span>
                <span class="material-symbols-rounded wd-edit-icon">edit</span>
              </button>
            {:else}
              <button class="wd-ex-feedback-add" on:click={() => editingExerciseIdx = idx}>
                <span class="material-symbols-rounded" style="font-size:14px">add_comment</span>
                Add a note on this exercise
              </button>
            {/if}
            {#if myFb?.seen_by_member_at && !myFb?.member_reply}
              <div class="wd-receipt">
                <span class="material-symbols-rounded" style="font-size:13px">done_all</span>
                Seen by {memberLabel(overview?.user)} · {relTime(myFb.seen_by_member_at)}
              </div>
            {/if}
            {#if myFb?.member_reply}
              <div class="wd-reply">
                <div class="avatar-chip member sm">
                  {#if overview?.user?.avatar_url}
                    <img src={resolveAssetUrl(overview.user.avatar_url)} alt="" />
                  {:else}
                    {initials(overview?.user)}
                  {/if}
                </div>
                <div class="wd-reply-body">
                  <span class="wd-reply-label">
                    {memberLabel(overview?.user)} replied
                    {#if myFb.member_replied_at} · {relTime(myFb.member_replied_at)}{/if}
                  </span>
                  <span class="wd-reply-text">{myFb.member_reply}</span>
                </div>
              </div>
            {/if}
            {#each exFb.filter(f => f.trainer_id !== $currentUser?.id) as f}
              <div class="wd-feedback-other">
                <span class="wd-feedback-author">{f.trainer_name}:</span>
                <span>{f.note}</span>
              </div>
            {/each}
          </div>
        {/if}
      {/each}
    {/if}
  </div>
</Sheet>

<!-- Edit Prescription Sheet — change date or notes after creating. -->
<Sheet open={showEditPrescription} on:close={() => showEditPrescription = false} title="Edit prescription">
  <div class="prescribe-sheet">
    <p class="hint">Update the date or add notes. Leave the date empty for an anytime prescription that the member can do on their own schedule.</p>

    <div class="field">
      <label>Date</label>
      <DateInput bind:value={editPxDate} />
    </div>

    <div class="field">
      <label>Notes</label>
      <textarea class="form-input" rows="3" bind:value={editPxNotes} placeholder="e.g. Focus on slow negatives"></textarea>
    </div>

    <div class="form-actions">
      <button class="btn btn-secondary" on:click={() => showEditPrescription = false}>Cancel</button>
      <button class="btn btn-primary" on:click={saveEditPrescription} disabled={editPxSaving}>
        {editPxSaving ? 'Saving…' : 'Save'}
      </button>
    </div>
  </div>
</Sheet>

<!-- Prescribe Workout Sheet -->
<Sheet open={showPrescribe} on:close={() => showPrescribe = false} title="Prescribe a workout">
  <div class="prescribe-sheet">
    <p class="hint">Pick a workout template and optionally a date. If no date is set, the member can start it whenever.</p>

    <div class="field">
      <label>Date (optional)</label>
      <DateInput bind:value={pxDate} />
    </div>

    <div class="field">
      <label>Workout template</label>
      {#if pxPrograms.length === 0}
        <p class="empty-inline">Create a program with workouts first to prescribe.</p>
      {:else}
        <select class="form-input" bind:value={pxTemplateId}>
          <option value={null}>— choose a workout —</option>
          {#each pxPrograms as prog}
            <optgroup label={prog.name}>
              {#each prog.templates as t}
                <option value={t.id}>{t.name}</option>
              {/each}
            </optgroup>
          {/each}
        </select>
      {/if}
    </div>

    <div class="field">
      <label>Notes (optional)</label>
      <textarea class="form-input" rows="3" bind:value={pxNotes} placeholder="e.g. Focus on slow negatives"></textarea>
    </div>

    <div class="form-actions">
      <button class="btn btn-secondary" on:click={() => showPrescribe = false}>Cancel</button>
      <button class="btn btn-primary" on:click={savePrescription} disabled={pxSaving || !pxTemplateId}>
        {pxSaving ? 'Saving…' : 'Prescribe'}
      </button>
    </div>
  </div>
</Sheet>

<style>
  .page { padding-bottom: calc(var(--nav-h) + var(--safe-bottom) + var(--mini-player-h, 0px) + 16px); }
  .content { padding: 16px var(--page-px); display: flex; flex-direction: column; gap: 12px; }
  .back-btn { background: none; border: none; cursor: pointer; color: var(--text-2); padding: 6px; display: flex; border-radius: var(--radius-sm); }
  .back-btn:hover { background: var(--surface-2); }

  .empty { text-align: center; padding: 48px 24px; color: var(--text-3); }
  .empty-icon { font-size: 48px; margin-bottom: 12px; }
  .empty-title { font-size: 15px; font-weight: 600; color: var(--text-2); margin: 6px 0 2px; }
  .empty-hint { font-size: 13px; color: var(--text-3); margin: 0; }
  .empty-inline { padding: 10px 0; color: var(--text-3); font-size: 13px; text-align: center; }

  .member-card {
    display: flex; align-items: center; gap: 12px;
    padding: 14px; background: var(--surface-1); border: 1px solid var(--border);
    border-radius: var(--radius-lg); cursor: pointer; text-align: left;
    transition: background var(--dur-fast);
  }
  .member-card:hover { background: var(--surface-2); }
  .avatar {
    width: 44px; height: 44px; border-radius: 50%;
    background: var(--accent-dim); color: var(--accent);
    font-size: 17px; font-weight: 700;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
    overflow: hidden;
  }
  .avatar-img { width: 100%; height: 100%; object-fit: cover; border-radius: 50%; }
  .member-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .member-name { font-size: 15px; font-weight: 600; color: var(--text-1); }
  .member-sub { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 12px; color: var(--text-3); }
  .tag { background: var(--accent-dim); color: var(--accent); padding: 2px 8px; border-radius: var(--radius-sm); font-weight: 600; }
  .muted { color: var(--text-3); }
  .chev { color: var(--text-3); }

  .card { background: var(--surface-1); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 16px; }
  .summary-card { }
  .summary-row { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; }
  .stat { display: flex; flex-direction: column; align-items: center; gap: 4px; min-width: 0; }
  .stat-val { font-size: 20px; font-weight: 700; color: var(--text-1); text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
  .stat-label { font-size: 11px; color: var(--text-3); text-transform: uppercase; letter-spacing: 0.05em; text-align: center; }

  .block { background: var(--surface-1); border: 1px solid var(--border); border-radius: var(--radius-lg); overflow: hidden; }
  .block-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; border-bottom: 1px solid var(--border); }
  .block-title { font-size: 14px; font-weight: 700; color: var(--text-1); margin: 0; }
  .btn.sm { padding: 6px 10px; font-size: 12px; height: auto; }

  .list-row {
    display: flex; align-items: center; gap: 12px;
    padding: 12px 16px; border-bottom: 1px solid var(--border);
  }
  .list-row:last-child { border-bottom: none; }
  .row-icon { color: var(--text-3); font-size: 20px; flex-shrink: 0; }
  .row-icon.done { color: var(--success); }
  .row-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .row-title { font-size: 13px; font-weight: 600; color: var(--text-1); }
  .row-sub { font-size: 11px; color: var(--text-3); }

  .badge { font-size: 10px; font-weight: 700; padding: 2px 8px; border-radius: var(--radius-sm); text-transform: uppercase; letter-spacing: 0.05em; }
  .active-badge { background: var(--accent-dim); color: var(--accent); }

  .btn-icon-sm {
    background: none; border: none; cursor: pointer; color: var(--text-3);
    padding: 4px; display: flex; border-radius: var(--radius-xs); flex-shrink: 0;
  }
  .btn-icon-sm:hover { color: var(--text-1); background: var(--surface-2); }
  .btn-icon-sm.danger:hover { color: var(--danger); background: rgba(255,92,92,0.1); }
  .muted-sep { color: var(--text-3); margin-left: 4px; }

  /* Prescribe sheet */
  .prescribe-sheet { display: flex; flex-direction: column; gap: 14px; padding: 4px 0 8px; }
  .prescribe-sheet .hint { font-size: 13px; color: var(--text-3); margin: 0; line-height: 1.4; }
  .prescribe-sheet .field { display: flex; flex-direction: column; gap: 6px; }
  .prescribe-sheet .field label { font-size: 12px; font-weight: 600; color: var(--text-2); text-transform: uppercase; letter-spacing: 0.04em; }
  .prescribe-sheet .form-input {
    width: 100%;
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-sm); padding: 10px 12px;
    color: var(--text-1); font-size: 14px; font-family: inherit;
    outline: none;
  }
  .prescribe-sheet .form-input:focus { border-color: var(--accent); }
  .prescribe-sheet textarea.form-input { resize: vertical; min-height: 60px; }
  .prescribe-sheet .form-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 4px; }
  .prescribe-sheet .form-actions .btn { flex: 1; height: 42px; }

  /* Workout-detail sheet */
  .workout-row {
    width: 100%;
    background: none; border: none; cursor: pointer; text-align: left;
  }
  .workout-row:hover { background: var(--surface-2); }
  .workout-volume {
    padding: 3px 10px; border-radius: var(--radius-full);
    background: var(--accent-dim); color: var(--accent);
    font-size: 11px; font-weight: 700; font-variant-numeric: tabular-nums;
    flex-shrink: 0;
  }
  .workout-feedback-marker {
    display: inline-flex; align-items: center; justify-content: center;
    color: var(--accent); flex-shrink: 0;
  }
  .workout-feedback-marker .material-symbols-rounded { font-size: 18px; }
  .workout-feedback-marker.faint { color: var(--text-3); }
  .workout-feedback-marker.has-reply {
    color: var(--accent);
    /* Subtle pulse so a fresh reply pulls the eye without being noisy. */
    animation: marker-pulse 2.5s ease-in-out infinite;
  }
  @keyframes marker-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.55; }
  }
  .workout-detail { padding: 4px 0 12px; display: flex; flex-direction: column; gap: 14px; }
  .wd-summary {
    display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px;
    padding: 12px; background: var(--surface-2); border-radius: var(--radius-md);
  }
  .wd-stat { display: flex; flex-direction: column; align-items: center; gap: 2px; min-width: 0; }
  .wd-stat-val { font-size: 16px; font-weight: 700; color: var(--text-1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; font-variant-numeric: tabular-nums; }
  .wd-stat-label { font-size: 10px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-3); }
  .wd-notes {
    display: flex; gap: 8px; align-items: flex-start;
    padding: 10px 12px; background: var(--surface-2); border-radius: var(--radius-md);
    font-size: 13px; color: var(--text-2); line-height: 1.4;
  }
  .wd-exercise {
    padding: 12px;
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-md);
  }
  .wd-ex-head {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 8px;
  }
  .wd-ex-name { font-size: 14px; font-weight: 700; color: var(--text-1); }
  .wd-ex-count { font-size: 11px; color: var(--text-3); }
  .wd-sets { display: flex; flex-direction: column; gap: 4px; }
  .wd-set {
    display: flex; align-items: center; gap: 10px;
    font-size: 13px; font-variant-numeric: tabular-nums;
  }
  .wd-set.warmup { color: var(--text-3); font-style: italic; }
  .wd-set-n { color: var(--text-3); min-width: 32px; }
  .wd-set-detail { color: var(--text-1); font-weight: 600; }
  .wd-set-rpe { color: var(--accent); font-weight: 600; font-size: 12px; }
  .wd-ex-notes {
    margin-top: 8px; padding-top: 8px;
    border-top: 1px solid var(--border);
    font-size: 12px; color: var(--text-3); font-style: italic;
  }

  /* Coach feedback editor + display inside the detail sheet */
  .wd-feedback {
    background: color-mix(in srgb, var(--accent) 6%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent) 22%, transparent);
    border-radius: var(--radius-md);
    padding: 12px;
    display: flex; flex-direction: column; gap: 8px;
  }
  .wd-feedback-head {
    display: flex; align-items: center; gap: 6px;
    font-size: 12px; font-weight: 700; letter-spacing: 0.04em;
    text-transform: uppercase; color: var(--text-3);
  }
  .wd-feedback-input {
    width: 100%;
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 10px 12px;
    color: var(--text-1); font-size: 14px; font-family: inherit;
    outline: none; resize: vertical; min-height: 56px;
  }
  .wd-feedback-input:focus { border-color: var(--accent); }
  .wd-feedback-actions {
    display: flex; justify-content: flex-end; gap: 8px;
  }
  .wd-feedback-save { height: 32px; padding: 0 14px; font-size: 12px; }
  .wd-add-workout-note {
    display: inline-flex; align-items: center; gap: 6px;
    background: none; border: 1px dashed var(--border);
    color: var(--text-2); font-size: 13px; font-weight: 600;
    padding: 8px 12px; border-radius: var(--radius-md); cursor: pointer;
    align-self: flex-start; font-family: inherit;
  }
  .wd-add-workout-note:hover { color: var(--accent); border-color: var(--accent); }
  .wd-feedback-other {
    margin-top: 6px; padding: 8px 10px;
    background: var(--surface-1); border-radius: var(--radius-sm);
    font-size: 12px; color: var(--text-2); line-height: 1.4;
  }
  .wd-feedback-author { font-weight: 700; color: var(--text-1); margin-right: 4px; }

  /* Member's reply — right-aligned + indented so the coach note + reply
     read as a back-and-forth conversation rather than two records. */
  .wd-reply {
    margin: 8px 0 4px 32px;  /* indent from the left so reply sits opposite the note */
    padding: 8px 10px;
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-md);
    border-bottom-right-radius: 4px;  /* bubble tail effect */
    display: flex; align-items: flex-start; gap: 6px;
  }
  .wd-reply-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .wd-reply-label { font-size: 11px; font-weight: 700; color: var(--text-3); text-transform: uppercase; letter-spacing: 0.04em; }
  .wd-reply-text { font-size: 13px; color: var(--text-1); line-height: 1.4; white-space: pre-wrap; }

  /* Read receipt — small, subtle, sits below the coach's note when the
     member has acknowledged it but hasn't replied yet. */
  .wd-receipt {
    margin-top: 4px;
    display: flex; align-items: center; gap: 4px;
    font-size: 11px; color: var(--text-3);
    padding-left: 2px;
  }
  .wd-receipt .material-symbols-rounded { color: var(--accent); }

  /* Danger variant for the secondary delete button in feedback editors */
  .btn-secondary.danger { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 40%, var(--border)); }
  .btn-secondary.danger:hover { background: color-mix(in srgb, var(--danger) 12%, transparent); }

  .wd-ex-feedback-edit {
    margin-top: 8px; padding-top: 8px;
    border-top: 1px solid var(--border);
    display: flex; flex-direction: column; gap: 8px;
  }
  .wd-ex-feedback-mine, .wd-ex-feedback-add {
    margin-top: 8px;
    width: 100%;
    display: flex; align-items: center; gap: 8px;
    padding: 8px 10px;
    background: var(--surface-1); border: 1px dashed var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-2); font-size: 12px; cursor: pointer;
    text-align: left; font-family: inherit;
  }
  .wd-ex-feedback-mine {
    background: color-mix(in srgb, var(--accent) 8%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
    color: var(--text-1);
  }
  .wd-ex-feedback-text { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .wd-edit-icon { font-size: 14px; color: var(--text-3); flex-shrink: 0; }
  .wd-ex-feedback-mine:hover, .wd-ex-feedback-add:hover { background: var(--accent-dim); }

  /* Assign-program "make active" checkbox row */
  .checkbox-row {
    display: flex; align-items: flex-start; gap: 10px;
    padding: 8px 0; cursor: pointer;
  }
  .checkbox-row input[type="checkbox"] {
    margin-top: 3px; flex-shrink: 0;
    accent-color: var(--accent);
  }
  .cb-label { display: block; font-size: 14px; font-weight: 600; color: var(--text-1); }
  .cb-hint  { display: block; font-size: 12px; color: var(--text-3); margin-top: 2px; }

  /* Header Add button */
  .header-actions { display: flex; gap: 8px; align-items: center; }
  .btn-primary-sm {
    display: flex; align-items: center; gap: 4px;
    padding: 8px 14px; font-size: 13px; font-weight: 600;
    background: var(--accent); color: var(--accent-text);
    border: none; border-radius: var(--radius-md); cursor: pointer;
  }
  .btn-primary-sm .material-symbols-rounded { font-size: 18px; }

  /* Assign-row (used by both add coachee + existing assign sheets) */
  .assign-row {
    display: flex; align-items: center; gap: 12px;
    width: 100%; padding: 12px 0;
    background: none; border: none; cursor: pointer;
    text-align: left;
    border-bottom: 1px solid var(--border);
  }
  .assign-row:last-child { border-bottom: none; }
  .assign-row:hover { background: var(--surface-2); }
  .assign-row .info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .assign-row .name { font-size: 14px; font-weight: 600; color: var(--text-1); }
  .assign-row .sub { font-size: 12px; color: var(--text-3); }
  .assign-row .chev { color: var(--text-3); }

  /* Activity feed */
  .activity-block { padding: 0; }
  .activity-row {
    width: 100%;
    background: none; border: none; cursor: pointer;
    text-align: left;
    border-bottom: 1px solid var(--border);
    padding: 12px 16px;
  }
  .activity-row:last-child { border-bottom: none; }
  .activity-row:hover { background: var(--surface-2); }
  .activity-row.unread { background: color-mix(in srgb, var(--accent) 6%, transparent); }
  .activity-row .row-action { color: var(--text-3); font-weight: 500; }
  .unread-pill {
    display: inline-block; margin-left: 6px;
    background: var(--accent); color: white;
    font-size: 11px; font-weight: 700;
    padding: 1px 7px; border-radius: var(--radius-full);
    line-height: 1.4;
  }
  .unread-dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: var(--accent); flex-shrink: 0;
  }
  .btn-link {
    background: none; border: none; cursor: pointer;
    color: var(--accent); font-size: 12px; font-weight: 600;
    padding: 4px 6px; border-radius: var(--radius-sm);
  }
  .btn-link:hover { background: var(--accent-dim); }

  .header-action {
    margin-left: auto;
    background: none; border: none; cursor: pointer;
    color: var(--text-3); padding: 6px; border-radius: var(--radius-sm);
    display: flex;
  }
  .header-action:hover { color: var(--text-1); background: var(--surface-2); }
  .header-action.danger:hover { color: var(--danger); background: rgba(255,92,92,0.1); }

  /* Avatar unread badge */
  .avatar-wrap { position: relative; flex-shrink: 0; }
  .avatar-badge {
    position: absolute; top: -4px; right: -4px;
    background: var(--accent); color: white;
    font-size: 10px; font-weight: 700;
    min-width: 18px; height: 18px;
    border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    border: 2px solid var(--surface-1);
    padding: 0 4px;
  }
</style>
