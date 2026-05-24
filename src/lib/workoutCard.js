// Render a workout summary to a shareable PNG image.
//
// 1080×1350 portrait (Instagram feed / story friendly). Uses <canvas> directly
// so there's no extra dependency and no web-font loading required — system
// sans-serif renders crisply everywhere.
//
// Pulls the current accent color from the CSS custom property so the card
// matches the user's theme.

const W = 1080;
const H = 1350;

function _cssVar(name, fallback) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch {
    return fallback;
  }
}

function _fmtVolume(v) {
  if (v >= 1000) return (v / 1000).toFixed(1) + 'k';
  return String(v);
}

function _fmtDuration(min) {
  if (!min) return '—';
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function _fmtDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
}

// Inline volume calc — keeping the share-card renderer self-contained so
// the canvas path doesn't drag in Svelte stores. Honors load_type on each
// exercise: paired = ×2, unilateral = ×2 (or sum L+R when per-side reps
// are logged), bilateral = ×1.
function _setVolume(set, loadType = 'bilateral') {
  if (!set) return 0;
  const w = Number(set.weight) || 0;
  if (w <= 0) return 0;
  if (loadType === 'unilateral') {
    if (set.reps_l != null || set.reps_r != null) {
      return w * ((Number(set.reps_l) || 0) + (Number(set.reps_r) || 0));
    }
    return w * (Number(set.reps) || 0) * 2;
  }
  if (loadType === 'paired') return w * (Number(set.reps) || 0) * 2;
  return w * (Number(set.reps) || 0);
}
function _computeStats(workout) {
  let volume = 0, sets = 0, exercisesWithCompletedSets = 0;
  for (const ex of workout.exercises || []) {
    const completed = (ex.sets || []).filter(s => s.completed && !s.warmup);
    if (completed.length > 0) exercisesWithCompletedSets++;
    const loadType = ex.load_type || 'bilateral';
    for (const s of completed) {
      volume += _setVolume(s, loadType);
      sets++;
    }
  }
  return { volume: Math.round(volume), sets, exercises: exercisesWithCompletedSets };
}

/**
 * @param {object} workout  { name, date, duration_min, exercises: [...] }
 * @param {string} unit     weight unit label ('lbs' or 'kg')
 * @returns {Promise<Blob>} PNG blob
 */
export async function renderWorkoutCard(workout, unit = 'lbs') {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  // ── Theme colors ────────────────────────────────────────────────────
  const accent = _cssVar('--accent', '#FF7433');
  const accent2 = _cssVar('--accent-2', accent);
  const bg = '#0A0B0F';
  const surface = '#16181E';
  const text1 = '#F5F6F8';
  const text2 = '#A8AFBD';
  const text3 = '#6B7280';

  // ── Background ───────────────────────────────────────────────────────
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // Soft accent glow in the top-right corner
  const grad = ctx.createRadialGradient(W - 100, -100, 50, W - 100, -100, 700);
  grad.addColorStop(0, accent + '55');  // add ~33% alpha
  grad.addColorStop(1, accent + '00');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // ── Header: LIFTTRACE wordmark ──────────────────────────────────────
  ctx.font = '700 32px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  ctx.fillStyle = accent;
  ctx.textAlign = 'left';
  ctx.fillText('LIFTTRACE', 64, 96);

  // Trophy flourish top-right
  ctx.font = '700 32px system-ui, -apple-system, sans-serif';
  ctx.fillStyle = '#FFD54F';
  ctx.textAlign = 'right';
  ctx.fillText('★ WORKOUT COMPLETE', W - 64, 96);

  // ── Workout name (big) ──────────────────────────────────────────────
  ctx.textAlign = 'left';
  ctx.fillStyle = text1;
  ctx.font = '800 76px system-ui, -apple-system, sans-serif';
  const name = (workout.name || 'Workout').slice(0, 28);
  ctx.fillText(name, 64, 220);

  // Date subline
  ctx.font = '500 28px system-ui, -apple-system, sans-serif';
  ctx.fillStyle = text2;
  ctx.fillText(_fmtDate(workout.date), 64, 268);

  // ── Stats grid (4 tiles) ────────────────────────────────────────────
  const stats = _computeStats(workout);
  const tiles = [
    { label: 'Volume (' + unit + ')', value: _fmtVolume(stats.volume) },
    { label: 'Sets',      value: String(stats.sets) },
    { label: 'Exercises', value: String(stats.exercises) },
    { label: 'Duration',  value: _fmtDuration(workout.duration_min) },
  ];
  const tileY = 320;
  const tileH = 140;
  const tileGap = 16;
  const tileW = (W - 64 * 2 - tileGap * 3) / 4;

  tiles.forEach((t, i) => {
    const x = 64 + i * (tileW + tileGap);
    // Tile bg
    ctx.fillStyle = surface;
    _roundRect(ctx, x, tileY, tileW, tileH, 18);
    ctx.fill();
    // Value
    ctx.fillStyle = text1;
    ctx.font = '800 48px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(t.value, x + tileW / 2, tileY + 70);
    // Label
    ctx.fillStyle = text3;
    ctx.font = '600 18px system-ui, -apple-system, sans-serif';
    ctx.fillText(t.label.toUpperCase(), x + tileW / 2, tileY + 108);
  });

  // ── Exercise list ────────────────────────────────────────────────────
  ctx.textAlign = 'left';
  const listTop = 520;
  let y = listTop;
  const maxListY = H - 120;  // leave room for footer
  const rowGap = 60;

  const completedExercises = (workout.exercises || []).filter(ex =>
    (ex.sets || []).some(s => s.completed)
  );

  // Group consecutive supersets together so the share card reads them
  // as a unit (a vertical accent rail down the left + small SUPERSET
  // label) rather than two unrelated rows. Matches the in-app summary
  // sheet's treatment.
  const groups = [];
  let gi = 0;
  while (gi < completedExercises.length) {
    const ex = completedExercises[gi];
    if (ex.superset_id) {
      const members = [];
      const ssId = ex.superset_id;
      while (gi < completedExercises.length && completedExercises[gi].superset_id === ssId) {
        members.push(completedExercises[gi]);
        gi++;
      }
      groups.push({ type: 'superset', members });
    } else {
      groups.push({ type: 'single', exercise: ex });
      gi++;
    }
  }

  // Helper: render one exercise row at current y. Returns the y the
  // caller should advance to.
  function _renderRow(ex, y, leftPad = 0) {
    const completed = (ex.sets || []).filter(s => s.completed);
    const top = completed.reduce((best, s) =>
      (!best || (s.weight || 0) > (best.weight || 0) ||
       ((s.weight || 0) === (best.weight || 0) && (s.reps || 0) > (best.reps || 0)))
        ? s : best, null);
    ctx.font = '600 32px system-ui, -apple-system, sans-serif';
    ctx.fillStyle = text1;
    ctx.textAlign = 'left';
    ctx.fillText((ex.exercise_name || '').slice(0, 28), 64 + leftPad, y);

    ctx.font = '500 28px ui-monospace, "SF Mono", Menlo, monospace';
    ctx.fillStyle = text2;
    ctx.textAlign = 'right';
    const setSummary = completed.length === 1
      ? `${top.weight}×${top.reps}`
      : `${completed.length} sets · top ${top.weight}×${top.reps}`;
    ctx.fillText(setSummary, W - 64, y);
    ctx.textAlign = 'left';
    return y + rowGap;
  }

  let rendered = 0;
  for (const g of groups) {
    if (y > maxListY - rowGap) break;
    if (g.type === 'superset') {
      const blockStart = y;
      // Superset header label
      ctx.font = '800 18px system-ui, -apple-system, sans-serif';
      ctx.fillStyle = accent;
      ctx.textAlign = 'left';
      ctx.fillText('SUPERSET', 80, y - 22);
      // Render each member with a left padding so they sit beside the rail.
      let memberCount = 0;
      for (const ex of g.members) {
        if (y > maxListY - rowGap) break;
        y = _renderRow(ex, y, 16);
        memberCount++;
        rendered++;
      }
      // Vertical accent rail down the left of the rendered block.
      const blockTop = blockStart - 34;
      const blockBottom = y - rowGap + 12;
      ctx.fillStyle = accent;
      ctx.fillRect(64, blockTop, 4, blockBottom - blockTop);
      // Bottom thin divider for the block.
      ctx.strokeStyle = '#23262E';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(64, y - rowGap + 22);
      ctx.lineTo(W - 64, y - rowGap + 22);
      ctx.stroke();
      y += 10;  // extra breathing room after a superset block
    } else {
      const yBefore = y;
      y = _renderRow(g.exercise, y, 0);
      rendered++;
      ctx.strokeStyle = '#23262E';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(64, yBefore + 18);
      ctx.lineTo(W - 64, yBefore + 18);
      ctx.stroke();
    }
  }

  // If we had to truncate, show "…and N more"
  const remaining = completedExercises.length - rendered;
  if (remaining > 0 && y <= maxListY) {
    ctx.font = '500 24px system-ui, -apple-system, sans-serif';
    ctx.fillStyle = text3;
    ctx.fillText(`…and ${remaining} more`, 64, y);
  }

  // ── Footer ────────────────────────────────────────────────────────────
  ctx.font = '600 22px system-ui, -apple-system, sans-serif';
  ctx.fillStyle = text3;
  ctx.textAlign = 'center';
  ctx.fillText('lifttrace · track every rep', W / 2, H - 50);

  return new Promise(resolve => canvas.toBlob(b => resolve(b), 'image/png', 0.95));
}

function _roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Share a workout card using Web Share API if available (with file),
 * otherwise trigger a download. Returns true if shared/downloaded.
 */
export async function shareWorkoutCard(workout, unit = 'lbs') {
  const blob = await renderWorkoutCard(workout, unit);
  if (!blob) return false;

  const filename = `lifttrace-${(workout.name || 'workout').replace(/\s+/g, '-').toLowerCase()}-${workout.date || 'today'}.png`;
  const file = new File([blob], filename, { type: 'image/png' });

  // Try Web Share API with file support (mobile)
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({
        files: [file],
        title: 'Workout Complete',
        text: workout.name || 'My workout',
      });
      return true;
    } catch (e) {
      // User cancelled or share failed — fall through to download
      if (e?.name === 'AbortError') return false;
    }
  }

  // Fallback: download
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}
