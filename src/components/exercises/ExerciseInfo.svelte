<script>
  /**
   * Shared exercise detail content — reused by the full ExerciseDetail
   * page and the ExerciseInfoSheet bottom-sheet preview. Takes an
   * exercise object and optionally a personal-record/history block.
   */
  export let exercise = null;
  export let pr = null;          // { weight, date, unit } or null
  export let history = null;     // [{ date, sets: [...] }] or null
</script>

{#if exercise}
  <!-- Media -->
  {#if exercise.video_url}
    <div class="media-card">
      {#if /youtube\.com|youtu\.be/.test(exercise.video_url)}
        <iframe class="media-video" src={exercise.video_url.replace('watch?v=', 'embed/')} title="Demo" allowfullscreen frameborder="0"></iframe>
      {:else}
        <video class="media-video" src={exercise.video_url} controls playsinline></video>
      {/if}
      {#if exercise.source}<span class="media-source">via {exercise.source}</span>{/if}
    </div>
  {:else if exercise.gif_url && exercise.img_url && exercise.gif_url !== exercise.img_url && /\.(jpg|jpeg|png|webp)$/i.test(exercise.gif_url)}
    <div class="media-card swap">
      <img class="swap-img frame-a" src={exercise.img_url} alt="Start position" />
      <img class="swap-img frame-b" src={exercise.gif_url} alt="End position" />
      {#if exercise.source}<span class="media-source">via {exercise.source}</span>{/if}
    </div>
  {:else if exercise.gif_url}
    <div class="media-card">
      <img class="media-img" src={exercise.gif_url} alt={exercise.name} />
      {#if exercise.source}<span class="media-source">via {exercise.source}</span>{/if}
    </div>
  {:else if exercise.img_url}
    <div class="media-card">
      <img class="media-img" src={exercise.img_url} alt={exercise.name} />
      {#if exercise.source}<span class="media-source">via {exercise.source}</span>{/if}
    </div>
  {/if}

  <!-- Category & Equipment -->
  <div class="info-row">
    {#if exercise.category}
      <span class="tag cat">{exercise.category}</span>
    {/if}
    {#each exercise.equipment || [] as eq}
      <span class="tag">{eq}</span>
    {/each}
  </div>

  <!-- Muscles -->
  {#if exercise.primary_muscles?.length}
    <div class="section">
      <h3 class="section-title">Primary Muscles</h3>
      <div class="tags">
        {#each exercise.primary_muscles as m}<span class="tag muscle">{m}</span>{/each}
      </div>
    </div>
  {/if}
  {#if exercise.secondary_muscles?.length}
    <div class="section">
      <h3 class="section-title">Secondary Muscles</h3>
      <div class="tags">
        {#each exercise.secondary_muscles as m}<span class="tag">{m}</span>{/each}
      </div>
    </div>
  {/if}

  <!-- Instructions -->
  {#if exercise.instructions}
    <div class="section">
      <h3 class="section-title">How to Perform</h3>
      <p class="instructions">{exercise.instructions}</p>
    </div>
  {/if}
  {#if exercise.tips}
    <div class="section">
      <h3 class="section-title">Tips</h3>
      <p class="instructions">{exercise.tips}</p>
    </div>
  {/if}

  <!-- Personal Record (optional) -->
  {#if pr}
    <div class="pr-card">
      <span class="material-symbols-rounded pr-icon">emoji_events</span>
      <div class="pr-info">
        <span class="pr-label">Personal Record</span>
        <span class="pr-value">{pr.weight} {pr.unit || ''}</span>
        <span class="pr-date">{pr.date}</span>
      </div>
    </div>
  {/if}

  <!-- History (optional) -->
  {#if history && history.length > 0}
    <div class="section">
      <h3 class="section-title">Recent History</h3>
      <div class="history-list">
        {#each history.slice(0, 10) as h}
          <div class="history-row">
            <span class="hist-date">{h.date}</span>
            <span class="hist-sets">
              {(h.sets || []).filter(s => s.completed).map(s => `${s.weight}×${s.reps}`).join(' | ')}
            </span>
          </div>
        {/each}
      </div>
    </div>
  {/if}
{/if}

<style>
  .info-row { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 16px; }
  .tag {
    padding: 4px 12px; border-radius: var(--radius-full);
    background: var(--surface-2); border: 1px solid var(--border);
    font-size: 12px; color: var(--text-2); text-transform: capitalize;
  }
  .tag.cat { background: var(--accent-dim); border-color: var(--accent); color: var(--accent); font-weight: 600; }
  .tag.muscle { background: rgba(206,147,216,0.15); border-color: rgba(206,147,216,0.3); color: #CE93D8; }

  .section { margin-bottom: 20px; }
  .section-title { font-size: 13px; font-weight: 700; color: var(--text-2); margin: 0 0 8px; text-transform: uppercase; letter-spacing: 0.04em; }
  .tags { display: flex; flex-wrap: wrap; gap: 6px; }
  .instructions { font-size: 14px; color: var(--text-2); line-height: 1.7; margin: 0; white-space: pre-wrap; }

  .pr-card {
    display: flex; align-items: center; gap: 12px;
    background: linear-gradient(135deg, rgba(255,213,79,0.1), rgba(255,213,79,0.05));
    border: 1px solid rgba(255,213,79,0.2);
    border-radius: var(--radius-lg); padding: 16px;
    margin-bottom: 20px;
  }
  .pr-icon { font-size: 32px; color: #FFD54F; }
  .pr-info { display: flex; flex-direction: column; gap: 2px; }
  .pr-label { font-size: 12px; color: var(--text-3); font-weight: 600; text-transform: uppercase; }
  .pr-value { font-size: 22px; font-weight: 700; color: #FFD54F; }
  .pr-date  { font-size: 12px; color: var(--text-3); }

  .history-list { display: flex; flex-direction: column; gap: 6px; }
  .history-row {
    display: flex; justify-content: space-between; align-items: center;
    padding: 10px 14px;
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: var(--radius-md);
  }
  .hist-date { font-size: 13px; font-weight: 600; color: var(--text-2); }
  .hist-sets { font-size: 13px; color: var(--text-1); font-variant-numeric: tabular-nums; }

  /* ── Media ────────────────────────────────────────────────────────── */
  .media-card {
    position: relative;
    border-radius: var(--radius-lg);
    overflow: hidden;
    background: var(--surface-2);
    margin-bottom: 16px;
    aspect-ratio: 4 / 3;
    max-height: 360px;
  }
  .media-img, .media-video, .swap-img {
    width: 100%; height: 100%; object-fit: contain;
    display: block;
  }
  .media-source {
    position: absolute; bottom: 8px; right: 8px;
    background: rgba(0,0,0,0.6); color: #fff;
    font-size: 10px; padding: 2px 8px;
    border-radius: var(--radius-full);
    text-transform: uppercase; letter-spacing: 0.04em;
  }
  .media-card.swap .swap-img {
    position: absolute; inset: 0;
    animation: swap-frames 1.8s steps(1, end) infinite;
  }
  .media-card.swap .frame-a { animation-delay: 0s; }
  .media-card.swap .frame-b { animation-delay: 0.9s; }
  @keyframes swap-frames {
    0%, 50%   { opacity: 1; }
    50.01%, 100% { opacity: 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    .media-card.swap .swap-img { animation: none; }
    .media-card.swap .frame-b { display: none; }
  }
</style>
