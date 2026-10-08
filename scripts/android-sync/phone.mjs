// One phone, running the app's own sync code against a real LiftTrace
// server (android-sync.test.js starts it), through one scenario. Prints the
// scenario's findings as JSON on the last line.
//
//   LT_SERVER=http://127.0.0.1:<port> LT_TOKEN=<phone account> LT_TOKENS=<json>
//   node --import ./scripts/android-sync/register.mjs scripts/android-sync/phone.mjs <scenario>

const realFetch = globalThis.fetch;
globalThis.__realFetch = realFetch;
const server = process.env.LT_SERVER;
const tokens = JSON.parse(process.env.LT_TOKENS || '{}');

// The web side: plain requests as another device would make them.
async function web(who, method, path, body) {
  const r = await realFetch(server + path, {
    method, headers: { 'Content-Type': 'application/json', ...(tokens[who] ? { Authorization: `Bearer ${tokens[who]}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} ${r.status} ${t.slice(0, 120)}`);
  return t ? JSON.parse(t) : null;
}

// A browser-ish global scope for the app's modules.
globalThis.__offline = false;
globalThis.fetch = (u, i) => (globalThis.__offline ? Promise.reject(new TypeError('Failed to fetch')) : (globalThis.__fetchHook?.(u, i) || realFetch(u, i)));
globalThis.window = globalThis;
globalThis.location = { origin: 'http://localhost', href: 'http://localhost/' };
globalThis.addEventListener ??= () => {};
globalThis.removeEventListener ??= () => {};
globalThis.dispatchEvent = () => true;
globalThis.document = { addEventListener() {}, visibilityState: 'visible' };
const store = new Map();
Object.defineProperty(globalThis, 'localStorage', { value: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k), key: () => null, length: 0 }, configurable: true });
Object.defineProperty(globalThis, 'navigator', { value: { language: 'en-US', languages: ['en-US'], userAgent: 'node', get onLine() { return !globalThis.__offline; } }, configurable: true });

const { getDb, dbQuery: q } = await import('../../src/lib/db-native.js');
await getDb();
(await import('../../src/lib/apiFetch.js')).installApiFetch();
const { LtApi: api } = await import('../../src/lib/api.js');
const sync = await import('../../src/lib/sync.js');
const offline = v => { globalThis.__offline = v; };
const later = ms => new Promise(r => setTimeout(r, ms));
const refused = [];
// Wait for a condition rather than a fixed time: a loaded machine is slow,
// not wrong.
async function until(check, what, ms = 60000) {
  const t0 = Date.now();
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + what);
    await later(25);
  }
}
// The app's reachability probe gives up after 3 s; on a loaded machine
// that reads as offline. Try again until the sync actually runs.
const syncRaw = () => until(async () => {
  const res = await sync.fullSync(true, true);
  return res.reason === 'offline' ? null : res;
}, 'the server to answer the sync');
async function syncNow() {
  const r = await syncRaw();
  if (r.pull?.ok === false) throw new Error('sync failed ' + JSON.stringify(r));
  refused.push(...(r.refused || []));
  return r;
}
const names = rows => rows.map(r => r.name);
const me = () => localStorage.setItem('wl:userId', process.env.LT_PHONE_USER);

const scenarios = {
  // Rows made offline (a plan, a day in it, an exercise, a workout using all
  // three) while another account takes the server ids the phone would use.
  async offlineIds() {
    // What stores/auth.js keeps for the signed-in account (not account 1).
    me();
    await syncNow();
    offline(true);
    const plan = await api.createProgram({ name: 'Phone Plan' });
    const day = await api.createTemplate({ program_id: plan.id, name: 'Phone Day', exercises: [] });
    const ex = await api.createExercise({ name: 'Phone Curl' });
    const madeBy = { program: plan.created_by, exercise: ex.created_by };
    await api.saveWorkout('2026-10-05', { name: 'Phone Session', program_id: plan.id, template_id: day.id,
      exercises: [{ exercise_id: ex.id, name: 'Phone Curl', sets: [{ reps: 5, weight: 50 }] }] });
    await api.reorderTemplates(plan.id, [day.id]);
    for (let i = 0; i < 4; i++) {
      const p = await web('other', 'POST', '/api/programs', { name: 'Other Plan ' + i });
      await web('other', 'POST', '/api/templates', { program_id: p.id, name: 'Other Day ' + i });
      await web('other', 'POST', '/api/exercises', { name: 'Other Ex ' + i });
    }
    const deviceIds = [plan.id, day.id, ex.id];
    offline(false);
    await syncNow();
    const progs = await web('phone', 'GET', '/api/programs');
    const serverPlan = progs.find(p => p.name === 'Phone Plan');
    const full = serverPlan && await web('phone', 'GET', `/api/programs/${serverPlan.id}`);
    const w = (await web('phone', 'GET', '/api/workout/2026-10-05')).workout;
    const exs = await web('phone', 'GET', '/api/exercises');
    const pulled = (await q(`SELECT created_by FROM programs WHERE name = 'Phone Plan'`))[0];
    return {
      deviceIds, madeBy, pulledMadeBy: pulled?.created_by ?? null, serverMadeBy: serverPlan?.created_by ?? null,
      serverPlans: progs.filter(p => p.name.startsWith('Phone')).length,
      serverDay: full?.templates?.map(t => t.name) || [],
      workout: w && {
        program: progs.find(p => p.id === w.program_id)?.name ?? null,
        template: full?.templates?.find(t => t.id === w.template_id)?.name ?? null,
        exercise: exs.find(e => e.id === w.exercises?.[0]?.exercise_id)?.name ?? null,
      },
      phonePlans: names(await q(`SELECT name FROM programs WHERE name LIKE 'Phone%'`)),
      phoneDeviceRows: (await q(`SELECT (SELECT COUNT(*) FROM programs WHERE id < 0) + (SELECT COUNT(*) FROM workout_templates WHERE id < 0)
        + (SELECT COUNT(*) FROM exercises WHERE id < 0) + (SELECT COUNT(*) FROM workout_log WHERE id < 0) AS n`))[0].n,
      queue: (await q(`SELECT COUNT(*) AS n FROM sync_queue`))[0].n,
      staleIdOpens: (await api.getProgram(plan.id))?.name ?? null,
      refused,
    };
  },

  // A plan made offline must not take the id of one the web makes meanwhile.
  async collide() {
    await web('phone', 'POST', '/api/programs', { name: 'Web Plan' });
    await syncNow();
    offline(true);
    await api.createProgram({ name: 'Phone Plan' });
    await web('phone', 'POST', '/api/programs', { name: 'Web Plan 2' });
    offline(false);
    await syncNow();
    return { phone: names(await api.getPrograms()).filter(n => /Web|Phone/.test(n)).sort() };
  },

  // An offline edit, then a later edit on the web.
  async editThenWeb() {
    const p = await web('phone', 'POST', '/api/programs', { name: 'Web Plan' });
    const ex = await web('phone', 'POST', '/api/exercises', { name: 'Web Ex' });
    await syncNow();
    offline(true);
    await api.updateProgram(p.id, { name: 'Renamed offline' });
    await api.updateExercise(ex.id, { name: 'Ex renamed offline' });
    offline(false);
    await syncNow();
    await web('phone', 'PUT', `/api/programs/${p.id}`, { name: 'Renamed on the web' });
    await web('phone', 'PUT', `/api/exercises/${ex.id}`, { name: 'Ex renamed on the web' });
    await syncNow();
    return { program: (await api.getProgram(p.id))?.name, exercise: (await api.getExercise(ex.id))?.name };
  },

  // Deletes on the web, and what older servers sent every phone.
  async deletes() {
    const keep = await web('phone', 'POST', '/api/programs', { name: 'Keep Plan' });
    const gone = await web('phone', 'POST', '/api/programs', { name: 'Gone Plan' });
    const day = await web('phone', 'POST', '/api/templates', { program_id: keep.id, name: 'Gone Day' });
    const ex = await web('phone', 'POST', '/api/exercises', { name: 'Gone Ex' });
    await web('phone', 'POST', '/api/ai/history', { role: 'user', content: 'hello' });
    await web('phone', 'PUT', '/api/settings', { key: 'weightUnit', value: 'lb' });
    const coach = await web('other', 'POST', '/api/programs', { name: 'Coach Plan' });
    await web('other', 'POST', '/api/templates', { program_id: coach.id, name: 'Coach Day' });
    await web('other', 'POST', `/api/programs/${coach.id}/assign`, { user_id: Number(process.env.LT_PHONE_USER) });
    const priv = await web('other', 'POST', '/api/programs', { name: 'Other Private' });
    await syncNow();
    // An older server sent every account's days to every phone.
    await q(`INSERT INTO programs (id, name, created_by) VALUES (?, 'Other Private', 1)`, [priv.id]);
    await q(`INSERT INTO workout_templates (id, program_id, name) VALUES (?, ?, 'Other Private Day')`, [priv.id * 1000, priv.id]);
    const before = { programs: names(await q(`SELECT name FROM programs WHERE created_by IS NOT NULL ORDER BY name`)),
      chat: (await q(`SELECT COUNT(*) AS n FROM ai_chat_history`))[0].n };
    await web('phone', 'DELETE', `/api/programs/${gone.id}`);
    await web('phone', 'DELETE', `/api/templates/${day.id}`);
    await web('phone', 'DELETE', `/api/exercises/${ex.id}`);
    await web('phone', 'DELETE', '/api/ai/history');
    await web('phone', 'DELETE', '/api/settings');
    await web('other', 'DELETE', `/api/programs/${coach.id}/assign/${process.env.LT_PHONE_USER}`);
    await syncNow();
    return {
      before,
      programs: names(await q(`SELECT name FROM programs WHERE created_by IS NOT NULL ORDER BY name`)),
      days: names(await q(`SELECT name FROM workout_templates WHERE name LIKE 'Gone%' OR name LIKE 'Coach%' OR name LIKE 'Other%'`)),
      exercises: names(await q(`SELECT name FROM exercises WHERE name LIKE 'Gone%'`)),
      assignments: (await q(`SELECT COUNT(*) AS n FROM program_assignments`))[0].n,
      chat: (await q(`SELECT COUNT(*) AS n FROM ai_chat_history`))[0].n,
      weightUnit: (await q(`SELECT value FROM user_settings WHERE key = 'weightUnit'`))[0]?.value ?? null,
    };
  },

  // Queued writes the server refuses.
  async refused() {
    const coach = await web('other', 'POST', '/api/programs', { name: 'Coach Plan' });
    const coachDay = await web('other', 'POST', '/api/templates', { program_id: coach.id, name: 'Coach Day' });
    await web('other', 'POST', `/api/programs/${coach.id}/assign`, { user_id: Number(process.env.LT_PHONE_USER) });
    const mine = await web('phone', 'POST', '/api/programs', { name: 'My Plan' });
    await syncNow();
    offline(true);
    await api.updateTemplate(coachDay.id, { name: 'Changed by the athlete' });
    const bad = await api.createProgram({ name: '' });
    await api.createTemplate({ program_id: bad.id, name: 'Day in a refused plan', exercises: [] });
    await api.updateProgram(mine.id, { name: 'Renamed offline' });
    await web('phone', 'DELETE', `/api/programs/${mine.id}`);
    offline(false);
    const r = await syncNow();
    await syncNow();
    // Every refusal the app reports (syncState, what its toast reads), from
    // whichever sync sent it: a sync the app starts on its own after a write
    // is queued may send them before this scenario's does.
    const { get } = await import('svelte/store');
    const reported = [...new Set((get(sync.syncState).refused || []).map(x => x.what))].sort();
    return {
      ok: r.ok && !reported.length,
      refused: reported,
      coachDay: (await q(`SELECT name FROM workout_templates WHERE id = ?`, [coachDay.id]))[0]?.name,
      programs: names(await q(`SELECT name FROM programs WHERE created_by IS NOT NULL ORDER BY name`)),
      orphanDay: (await q(`SELECT COUNT(*) AS n FROM workout_templates WHERE name = 'Day in a refused plan'`))[0].n,
      queue: (await q(`SELECT COUNT(*) AS n FROM sync_queue`))[0].n,
    };
  },

  // A second sync while the first is still sending.
  async overlap() {
    const x = await web('other', 'POST', '/api/programs', { name: 'Plan X' });
    const y = await web('other', 'POST', '/api/programs', { name: 'Plan Y' });
    const user = Number(process.env.LT_PHONE_USER);
    await web('other', 'POST', `/api/programs/${x.id}/assign`, { user_id: user, make_active: false });
    await web('other', 'POST', `/api/programs/${y.id}/assign`, { user_id: user, make_active: false });
    await syncNow();
    offline(true);
    await api.setActiveProgram(x.id);
    await later(1100);   // the coach's change lands a second later on the server
    await web('other', 'POST', `/api/programs/${y.id}/assign`, { user_id: user });
    offline(false);
    const timeline = [];
    let writing = 0;
    globalThis.__slowWrites = async () => { writing++; timeline.push('write'); await later(800); writing--; };
    const { CapacitorHttp } = await import('@capacitor/core');
    const get = CapacitorHttp.get;
    CapacitorHttp.get = o => { if (o.url.includes('/api/sync/pull')) timeline.push(`pull (writes in flight: ${writing})`); return get(o); };
    const first = syncRaw();
    await until(() => writing > 0, 'the first sync to be sending');
    await syncRaw();
    const active = names(await q(`SELECT p.name FROM program_assignments a JOIN programs p ON p.id = a.program_id WHERE a.active = 1`));
    await first;
    globalThis.__slowWrites = null;
    return { timeline, activeAfterSecond: active, listed: (await api.getPrograms()).filter(p => p.is_active).map(p => p.name) };
  },

  // A server without user accounts: Delete all custom exercises on the web,
  // and queued offline on the phone with more writes behind it.
  async singleUser() {
    await web('other', 'POST', '/api/exercises', { name: 'Web Custom A' });
    const webDelete = await web('other', 'DELETE', '/api/exercises/custom/all');
    await web('other', 'POST', '/api/exercises', { name: 'Phone Custom B' });
    const { currentUser } = await import('../../src/stores/auth.js');
    currentUser.set({ id: 1, username: 'local' });
    await syncNow();
    offline(true);
    await api.deleteAllCustomExercises();
    await api.saveWorkout('2026-10-06', { name: 'Queued after delete-all', exercises: [] });
    await api.createExercise({ name: 'Phone Custom C' });
    offline(false);
    await syncNow();
    let user; currentUser.subscribe(v => { user = v; })();
    const custom = await web('other', 'GET', '/api/exercises');
    return {
      web: webDelete, refused, stillSignedIn: !!user,
      queue: (await q(`SELECT COUNT(*) AS n FROM sync_queue`))[0].n,
      serverCustom: custom.filter(e => !e.is_global).map(e => e.name),
      serverWorkout: [(await web('other', 'GET', '/api/workout/2026-10-06')).workout?.name].filter(Boolean),
      phoneCustom: names(await q(`SELECT name FROM exercises WHERE is_global = 0 AND deleted_at IS NULL ORDER BY name`)),
    };
  },

  // An earlier version queued a new workout under its own (positive) id,
  // which the server then also gives it; an edit queued behind it names it.
  async legacySameId() {
    me();
    await web('phone', 'PUT', '/api/workout/2026-10-01', { name: 'Server Day A', exercises: [] });
    await syncNow();
    const dayA = (await web('phone', 'GET', '/api/workout/2026-10-01')).workout.id;
    const next = dayA + 1;   // the server's next workout id
    const q1 = await sync.enqueueWrite('PUT', '/api/workout/2026-10-05', { name: 'Offline', exercises: [{ uuid: 'a1', name: 'Squat', sets: [{ uuid: 's1', reps: 5 }] }] });
    await sync.noteQueuedLocalId(q1, next);
    await sync.enqueueWrite('PUT', '/api/workout/2026-10-05', { id: next, name: 'Offline edited', exercises: [{ uuid: 'a1', name: 'Squat', sets: [{ uuid: 's1', reps: 5 }, { uuid: 's2', reps: 6 }] }] });
    // And one whose device id is a row pulled since (Day A's).
    const q2 = await sync.enqueueWrite('PUT', '/api/workout/2026-10-06', { name: 'Other offline', exercises: [] });
    await sync.noteQueuedLocalId(q2, dayA);
    await sync.enqueueWrite('PUT', '/api/workout/2026-10-06', { id: dayA, name: 'Other offline edited', exercises: [] });
    await syncNow();
    const w5 = (await web('phone', 'GET', '/api/workout/2026-10-05')).workout;
    return {
      server05: { name: w5?.name, sets: w5?.exercises?.[0]?.sets?.length },
      server06: (await web('phone', 'GET', '/api/workout/2026-10-06')).workout?.name,
      phoneDayA: (await q(`SELECT name FROM workout_log WHERE date = '2026-10-01'`)).map(r => r.name),
      refused,
    };
  },

  // Rows only this phone has: made standalone before connecting, and one
  // whose upload failed. Upload leaves one of each, not two.
  async localOnly() {
    me();
    const srv = process.env.LT_SERVER;
    process.env.LT_SERVER = '';
    const a = await api.createProgram({ name: 'Standalone Plan' });
    await api.createTemplate({ program_id: a.id, name: 'Standalone Day', exercises: [] });
    const b = await api.createProgram({ name: 'Fails To Upload' });
    await api.createTemplate({ program_id: b.id, name: 'Day Of Failed Upload', exercises: [] });
    await api.saveWorkout('2026-10-01', { name: 'Standalone Workout', program_id: a.id, exercises: [] });
    process.env.LT_SERVER = srv;
    globalThis.__fetchHook = (u, i) => (String(u).endsWith('/api/programs') && i?.method === 'POST' && String(i.body).includes('Fails To Upload'))
      ? Promise.resolve(new Response(JSON.stringify({ error: 'boom' }), { status: 500 })) : null;
    const { uploadLocalToServer } = await import('../../src/lib/migrate.js');
    await uploadLocalToServer();
    globalThis.__fetchHook = null;
    await syncNow(); await syncNow();
    return {
      programs: names(await q(`SELECT name FROM programs WHERE name IN ('Standalone Plan', 'Fails To Upload') ORDER BY name`)),
      workoutProgram: (await q(`SELECT p.name FROM workout_log w LEFT JOIN programs p ON p.id = w.program_id WHERE w.name = 'Standalone Workout'`)).map(r => r.name),
    };
  },

  // Back online before the sync: a logged workout using an exercise made
  // offline, and a program workout added to a program made offline.
  async beforeFlush() {
    me();
    await syncNow();
    offline(true);
    const ex = await api.createExercise({ name: 'Phone Curl' });
    const plan = await api.createProgram({ name: 'Phone Plan' });
    offline(false);
    await api.saveWorkout('2026-10-05', { name: 'S', exercises: [{ uuid: 'e1', exercise_id: ex.id, name: 'Phone Curl', sets: [] }] });
    let day; try { day = await api.createTemplate({ program_id: plan.id, name: 'Day added online', exercises: [] }); } catch (e) { day = 'error ' + e.message; }
    await syncNow(); await syncNow();
    const exs = await web('phone', 'GET', '/api/exercises');
    const progs = await web('phone', 'GET', '/api/programs');
    const sp = progs.find(p => p.name === 'Phone Plan');
    return {
      dayError: typeof day === 'string' ? day : null,
      workoutExercise: (await web('phone', 'GET', '/api/workout/2026-10-05')).workout?.exercises?.[0]?.exercise_id === exs.find(e => e.name === 'Phone Curl')?.id,
      serverDays: sp ? (await web('phone', 'GET', `/api/programs/${sp.id}`)).templates.map(t => t.name) : [],
      refused,
    };
  },

  // A create reaches the server but its answer is lost: sent again, one row.
  async lostAnswer() {
    await syncNow();
    offline(true);
    await api.createProgram({ name: 'Phone Plan' });
    await api.createCardio({ date: '2026-10-05', activity: 'Phone Row', duration_min: 20 });
    offline(false);
    let drop = 2;
    globalThis.__httpHook = async (method, o) => {
      if (drop > 0 && method === 'POST' && /\/api\/(programs|cardio)$/.test(o.url)) {
        drop--;
        await realFetch(o.url, { method, headers: o.headers, body: JSON.stringify(o.data) });
        throw new TypeError('Failed to fetch');
      }
      return null;
    };
    await syncRaw();
    globalThis.__httpHook = null;
    await syncNow();
    return {
      serverPlans: (await web('phone', 'GET', '/api/programs')).filter(p => p.name === 'Phone Plan').length,
      serverCardio: (await web('phone', 'GET', '/api/cardio')).filter(c => c.activity === 'Phone Row').length,
      queue: (await q(`SELECT COUNT(*) AS n FROM sync_queue`))[0].n,
    };
  },

  // Settings kept per exercise, and cardio edited offline, follow the
  // offline-made row to its server id.
  async followIds() {
    me();
    await web('phone', 'POST', '/api/cardio', { date: '2026-10-01', activity: 'Web Run', duration_min: 30 });
    await syncNow();
    const st = await import('../../src/stores/settings.js');
    offline(true);
    const ex = await api.createExercise({ name: 'Phone Press' });
    st.restPerExercise.set({ [ex.id]: 150 });
    st.favoriteExercises.set([ex.id]);
    const c = await api.createCardio({ date: '2026-10-05', activity: 'Phone Row', duration_min: 20 });
    await api.updateCardio(c.id, { date: '2026-10-05', activity: 'Phone Row', duration_min: 25 });
    await until(async () => (await q(`SELECT COUNT(*) AS n FROM sync_queue WHERE table_name = '/api/settings'`))[0].n >= 2, 'the settings saves to queue');
    offline(false);
    await syncNow();
    const serverEx = (await web('phone', 'GET', '/api/exercises')).find(e => e.name === 'Phone Press')?.id;
    // The move to the server id is saved again through the debounced save.
    const settings = await until(async () => {
      await syncNow();
      const s2 = await web('phone', 'GET', '/api/settings');
      return s2.restPerExercise && s2.restPerExercise[serverEx] != null && Array.isArray(s2.favoriteExercises) && s2.favoriteExercises.includes(serverEx) ? s2 : null;
    }, 'the moved settings to reach the server');
    return {
      rest: settings.restPerExercise, fav: settings.favoriteExercises, serverEx,
      cardio: (await web('phone', 'GET', '/api/cardio')).map(r => `${r.activity} ${r.duration_min}`).sort(),
    };
  },

  // Following a program on a server without user accounts.
  async soloActive() {
    await syncNow();
    const progs = await api.getPrograms();
    const p1 = progs.find(p => p.name === 'Push / Pull / Legs'), p2 = progs.find(p => p.name === 'Upper / Lower');
    const active = async () => (await api.getPrograms()).filter(p => p.is_active).map(p => p.name);
    offline(true);
    await api.setActiveProgram(p1.id);
    offline(false);
    await syncNow(); await syncNow();
    const afterSync = await active();
    await web('other', 'POST', `/api/programs/${p2.id}/activate`);
    await syncNow();
    const afterWeb = await active();
    return { afterSync, afterWeb };
  },

  // Rows a pull skips for a queued write are asked for again.
  async skippedRows() {
    const user = Number(process.env.LT_PHONE_USER);
    const x = await web('other', 'POST', '/api/programs', { name: 'Plan X', duration_weeks: 4 });
    await web('other', 'POST', `/api/programs/${x.id}/assign`, { user_id: user });
    await syncNow();
    offline(true);
    await api.setProgramWeekCursor(x.id, 2);
    offline(false);
    globalThis.__httpHook = async (method, o) => (method === 'POST' && o.url.includes('/week-cursor')) ? { status: 503, data: { error: 'busy' } } : null;
    const z = await web('other', 'POST', '/api/programs', { name: 'Plan Z' });
    await web('other', 'POST', `/api/programs/${z.id}/assign`, { user_id: user, make_active: false });
    await later(2100);   // the next pull's watermark lands past Z's second
    await syncNow();
    globalThis.__httpHook = null;
    await later(1100);
    await syncNow(); await syncNow();
    return { assigned: names(await q(`SELECT p.name FROM program_assignments a JOIN programs p ON p.id = a.program_id ORDER BY p.name`)) };
  },

  // A sync that shares a waiting round gets the same answer; deleting what
  // the web already deleted is quiet.
  async rounds() {
    const p = await web('phone', 'POST', '/api/programs', { name: 'Doomed' });
    const r = await web('phone', 'POST', '/api/programs', { name: 'Renamed Gone' });
    await syncNow();
    offline(true);
    await api.deleteProgram(p.id);
    await api.updateProgram(r.id, { name: 'Renamed offline' });
    offline(false);
    await web('phone', 'DELETE', `/api/programs/${p.id}`);
    await web('phone', 'DELETE', `/api/programs/${r.id}`);
    globalThis.__httpHook = async (method) => { if (method !== 'GET') await later(300); return null; };
    const first = syncRaw();
    await until(async () => (await sync.getSyncStatus()).flushing, 'the first sync to be sending');
    const second = sync.runSync();
    // The server just answered, so this one doesn't probe again: it joins
    // the round the second is waiting in.
    const third = sync.fullSync(true);
    const [a, , c] = await Promise.all([first, second, third]);
    globalThis.__httpHook = null;
    return { first: { ok: a.ok, refused: a.refused.map(x => x.what) }, third: { hasOk: 'ok' in c, hasRefused: Array.isArray(c.refused) } };
  },

  // Replace with server deletes this phone's data.
  async download() {
    process.env.LT_SERVER = '';
    await api.createProgram({ name: 'Standalone Plan' });
    await api.saveWorkout('2026-10-01', { name: 'Standalone Workout', exercises: [] });
    const count = async () => (await q(`SELECT (SELECT COUNT(*) FROM programs) + (SELECT COUNT(*) FROM workout_log) AS n`))[0].n;
    const before = await count();
    const dbn = await import('../../src/lib/db-native.js');
    await dbn.destroyLocalDb();
    await dbn.getDb();
    return { before, after: await count() };
  },

  // Body stats only this phone has: on a date the server also has (merged),
  // and under an id the server uses for another date (kept).
  async bodyStats() {
    me();
    await web('phone', 'PUT', '/api/body-stats/2026-09-01', { stats: { weight: 80 } });
    await web('phone', 'PUT', '/api/body-stats/2026-10-01', { stats: { weight: 79 } });
    const srv = process.env.LT_SERVER;
    process.env.LT_SERVER = '';
    await api.saveBodyStats('2026-10-01', { stats: { weight: 77, waist: 81 } });
    await api.saveBodyStats('2026-10-02', { stats: { arms: 35 } });
    process.env.LT_SERVER = srv;
    await syncNow(); await syncNow();
    const stats = async (d) => { const r = (await q(`SELECT stats FROM body_stats_log WHERE date = ?`, [d]))[0]; return r ? JSON.parse(r.stats) : null; };
    return {
      phone01: await stats('2026-10-01'), phone02: await stats('2026-10-02'), phone0901: await stats('2026-09-01'),
      server01: (await web('phone', 'GET', '/api/body-stats/2026-10-01')).stats?.stats ?? null,
    };
  },

  // Rows only this phone has, moved out of the way of the server's rows with
  // the same ids, then written to: created on the server first, never lost.
  async movedRows() {
    me();
    await web('phone', 'PUT', '/api/workout/2026-09-01', { name: 'Server Row', exercises: [] });
    await web('phone', 'POST', '/api/programs', { name: 'Web Plan' });
    await later(1100);   // made on the phone later than the server's rows
    const srv = process.env.LT_SERVER;
    process.env.LT_SERVER = '';
    await api.saveWorkout('2026-10-01', { name: 'Local Only', notes: 'precious', exercises: [{ uuid: 'x1', name: 'Curl', sets: [{ uuid: 'y1', reps: 10 }] }] });
    await api.saveWorkout('2026-10-03', { name: 'Local Untouched', exercises: [] });
    for (let i = 0; i < 3; i++) await api.createProgram({ name: 'Filler ' + i });
    const lp = await api.createProgram({ name: 'Local Plan' });
    await api.createTemplate({ program_id: lp.id, name: 'Local Day 1', exercises: [] });
    process.env.LT_SERVER = srv;
    await syncNow();
    const moved = (await q(`SELECT id FROM workout_log WHERE name = 'Local Only'`))[0];
    const movedPlan = (await q(`SELECT id FROM programs WHERE name = 'Local Plan'`))[0];
    // Written to after reconnecting, and an offline session on the date of
    // another row only this phone has.
    await api.saveWorkout('2026-10-01', { id: moved.id, name: 'Local Only edited', notes: 'precious', exercises: [{ uuid: 'x1', name: 'Curl', sets: [{ uuid: 'y1', reps: 12 }] }] });
    await api.createTemplate({ program_id: movedPlan.id, name: 'Local Day 2', exercises: [] });
    offline(true);
    await api.saveWorkout('2026-10-03', { new_session: true, name: 'Offline Session', exercises: [] });
    offline(false);
    await syncNow(); await syncNow();
    const sp = (await web('phone', 'GET', '/api/programs')).find(p => p.name === 'Local Plan');
    return {
      movedIds: [moved.id < 0, movedPlan.id < 0],
      server01: (await web('phone', 'GET', '/api/workout/2026-10-01/sessions')).sessions.map(w => `${w.name} ${w.notes} ${w.exercises[0]?.sets?.[0]?.reps}`),
      serverPlanDays: sp ? (await web('phone', 'GET', `/api/programs/${sp.id}`)).templates.map(t => t.name).sort() : null,
      phone03: names(await q(`SELECT name FROM workout_log WHERE date = '2026-10-03' ORDER BY name`)),
      phoneDays: names(await q(`SELECT name FROM workout_templates WHERE name LIKE 'Local Day%' ORDER BY name`)),
      refused,
    };
  },

  // Upload: two sessions on one day stay two, the server's own workout that
  // day is untouched, body stats go up, the program being followed stays.
  async uploadSessions() {
    me();
    await web('phone', 'PUT', '/api/workout/2026-10-02', { name: 'Web Session', notes: 'web notes', duration_min: 45, exercises: [] });
    await web('phone', 'PUT', '/api/body-stats/2026-10-01', { stats: { weight: 80 } });
    const srv = process.env.LT_SERVER;
    process.env.LT_SERVER = '';
    await api.saveWorkout('2026-10-01', { name: 'Morning', notes: 'AM', exercises: [{ uuid: 'a1', name: 'Squat', sets: [{ uuid: 's1', reps: 5 }] }] });
    await api.saveWorkout('2026-10-01', { new_session: true, name: 'Evening', notes: 'PM', exercises: [{ uuid: 'b1', name: 'Bench', sets: [{ uuid: 's2', reps: 8 }] }] });
    await api.saveWorkout('2026-10-02', { name: 'Phone 2nd', exercises: [] });
    await api.saveBodyStats('2026-10-01', { stats: { waist: 81 } });
    const p = await api.createProgram({ name: 'Standalone Plan', duration_weeks: 4 });
    await api.setActiveProgram(p.id);
    await api.setProgramWeekCursor(p.id, 2);
    process.env.LT_SERVER = srv;
    const { uploadLocalToServer } = await import('../../src/lib/migrate.js');
    const sum = await uploadLocalToServer();
    const again = await uploadLocalToServer();   // nothing left to send twice
    await syncNow(); await syncNow();
    const s1 = (await web('phone', 'GET', '/api/workout/2026-10-01/sessions')).sessions;
    const s2 = (await web('phone', 'GET', '/api/workout/2026-10-02/sessions')).sessions;
    const progs = await web('phone', 'GET', '/api/programs');
    const active = progs.find(x => x.is_active);
    return {
      errors: sum.errors.length + again.errors.length,
      server01: s1.map(w => `${w.name} ${w.notes}`).sort(),
      server02: s2.map(w => `${w.name} ${w.notes ?? ''} ${w.duration_min ?? ''}`.trim()).sort(),
      body01: (await web('phone', 'GET', '/api/body-stats/2026-10-01')).stats?.stats,
      serverActive: active ? `${active.name} week ${active.current_week ?? '?'}` : null,
      phoneActive: (await api.getPrograms()).filter(x => x.is_active).map(x => x.name),
      phoneSessions: (await q(`SELECT COUNT(*) AS n FROM workout_log WHERE date IN ('2026-10-01', '2026-10-02')`))[0].n,
    };
  },

  // A create sent again after its row was deleted on the web doesn't bring it
  // back; an online create whose answer is lost makes one row.
  async createKeys() {
    me();
    await syncNow();
    offline(true);
    await api.createProgram({ name: 'Made Then Deleted' });
    offline(false);
    let drop = 1;
    globalThis.__httpHook = async (method, o) => {
      if (drop > 0 && method === 'POST' && o.url.endsWith('/api/programs')) {
        drop--;
        await realFetch(o.url, { method, headers: o.headers, body: JSON.stringify(o.data) });
        throw new TypeError('Failed to fetch');
      }
      return null;
    };
    await syncRaw();
    globalThis.__httpHook = null;
    const made = (await web('phone', 'GET', '/api/programs')).find(p => p.name === 'Made Then Deleted');
    await web('phone', 'DELETE', `/api/programs/${made.id}`);
    await syncNow(); await syncNow();
    const afterReplay = {
      server: (await web('phone', 'GET', '/api/programs')).filter(p => p.name === 'Made Then Deleted').length,
      phone: (await q(`SELECT COUNT(*) AS n FROM programs WHERE name = 'Made Then Deleted'`))[0].n,
      queue: (await q(`SELECT COUNT(*) AS n FROM sync_queue`))[0].n, refused: refused.length,
    };
    // Online, with the answer lost on the way back.
    let lose = 1;
    globalThis.__fetchHook = (u, i) => (lose > 0 && String(u).endsWith('/api/programs') && i?.method === 'POST')
      ? (lose--, realFetch(u, i).then(() => { throw new TypeError('Failed to fetch'); })) : null;
    await api.createProgram({ name: 'Online Lost Answer' });
    globalThis.__fetchHook = null;
    await syncNow(); await syncNow();
    return { afterReplay, onlineCopies: (await web('phone', 'GET', '/api/programs')).filter(p => p.name === 'Online Lost Answer').length };
  },

  // A write the server keeps failing doesn't make every pull bigger.
  async floorAges() {
    me();
    const p = await web('phone', 'POST', '/api/programs', { name: 'P' });
    await syncNow();
    offline(true);
    await api.updateProgram(p.id, { name: 'P renamed' });
    offline(false);
    globalThis.__httpHook = async (method, o) => (method === 'PUT' && o.url.includes('/api/programs/')) ? { status: 503, data: { error: 'busy' } } : null;
    await syncNow();
    const db = await import('../../src/lib/db-native.js');
    const last = await db.getSyncMeta('last_server_time');
    const old = new Date(Date.parse(last) - 2 * 3600 * 1000).toISOString();
    await db.setSyncMeta('since_floor', old);
    const asked = [];
    const { CapacitorHttp } = await import('@capacitor/core');
    const get = CapacitorHttp.get;
    CapacitorHttp.get = o => { if (o.url.includes('/api/sync/pull')) asked.push(new URL(o.url).searchParams.get('since') || ''); return get(o); };
    await syncNow();
    const whileFailing = { since: asked.at(-1), floor: await db.getSyncMeta('since_floor'), later: await db.getSyncMeta('full_pull_when_drained') };
    globalThis.__httpHook = null;
    await syncNow();
    return { oldFloor: old, whileFailing, sinceAfterDrained: asked.at(-1), laterAfter: await db.getSyncMeta('full_pull_when_drained'),
      server: (await web('phone', 'GET', '/api/programs')).find(x => x.id === p.id)?.name };
  },

  // Another account signs in on this phone (local-account.js): with the
  // first one's changes still waiting, and with nothing waiting.
  async accounts() {
    const platform = await import('./platform.mjs');
    const la = await import('../../src/lib/local-account.js');
    const athlete = { id: Number(process.env.LT_PHONE_USER) }, coach = { id: Number(process.env.LT_OTHER_USER) };
    const signIn = (token, user) => { platform.setAuthToken(token); localStorage.setItem('wl:userId', String(user.id)); };
    const seen = [];
    globalThis.__httpHook = async (method, o) => { if (method !== 'GET') seen.push({ path: o.url.replace(/^https?:\/\/[^/]+/, ''), auth: o.headers?.Authorization || '' }); return null; };
    signIn(tokens.phone, athlete);
    await la.prepareLocalAccount(athlete, { confirm: async () => true });
    await web('phone', 'POST', '/api/programs', { name: 'Athlete Synced' });
    await syncNow();
    offline(true);
    await api.createProgram({ name: 'Athlete Offline' });
    offline(false);
    // The coach signs in on this phone. Before the app has checked, a sync
    // refuses: the copy is the athlete's.
    signIn(tokens.other, coach);
    const early = await sync.fullSync(true, true);
    // Asked, and says keep: the sign-in is undone, nothing is cleared.
    let asked = null;
    const kept = await la.prepareLocalAccount(coach, { confirm: async n => { asked = n; return false; } });
    const afterKeep = names(await q(`SELECT name FROM programs WHERE name LIKE 'Athlete%' ORDER BY name`));
    // The athlete signs back in: no question, the waiting change goes up.
    signIn(tokens.phone, athlete);
    let askedAthlete = null;
    const back = await la.prepareLocalAccount(athlete, { confirm: async n => { askedAthlete = n; return true; } });
    await syncNow();
    // The athlete makes another change offline; the coach signs in and
    // discards it.
    offline(true);
    await api.createProgram({ name: 'Athlete Discarded' });
    offline(false);
    signIn(tokens.other, coach);
    let askedAgain = null;
    const discarded = await la.prepareLocalAccount(coach, { confirm: async n => { askedAgain = n; return true; } });
    await syncNow();
    const coachPhone = names(await q(`SELECT name FROM programs WHERE name LIKE 'Athlete%' OR name LIKE 'Coach%' ORDER BY name`));
    // Now the coach has nothing waiting; the athlete signs in: no question.
    await web('other', 'POST', '/api/programs', { name: 'Coach Plan' });
    await syncNow();
    signIn(tokens.phone, athlete);
    let askedClean = null;
    const clean = await la.prepareLocalAccount(athlete, { confirm: async n => { askedClean = n; return true; } });
    await syncNow();
    globalThis.__httpHook = null;
    const coachAuth = `Bearer ${tokens.other}`;
    return {
      early: early.reason,
      keep: { kept, asked, afterKeep },
      back: { back, askedAthlete },
      discard: { discarded, askedAgain, coachPhone },
      clean: { clean, askedClean, athletePhone: names(await q(`SELECT name FROM programs WHERE name LIKE 'Athlete%' OR name LIKE 'Coach%' ORDER BY name`)) },
      athleteServer: (await web('phone', 'GET', '/api/programs')).filter(p => p.name.startsWith('Athlete')).map(p => p.name).sort(),
      coachServer: (await web('other', 'GET', '/api/programs')).filter(p => p.name.startsWith('Athlete')).map(p => p.name),
      athleteWritesUnderCoach: seen.filter(x => x.auth === coachAuth && /programs/.test(x.path)).length,
    };
  },

  // The same account at another address of the same server, and opening the
  // app offline: no question, nothing cleared, the waiting change goes up.
  async sameAccountElsewhere() {
    const la = await import('../../src/lib/local-account.js');
    const athlete = { id: Number(process.env.LT_PHONE_USER) };
    me();
    await la.prepareLocalAccount(athlete, { confirm: async () => true });
    await syncNow();
    offline(true);
    await api.createProgram({ name: 'Made Before Moving' });
    // Opened with no connection: the server's id is the one seen before.
    let askedOffline = null;
    const offlineOk = await la.prepareLocalAccount(athlete, { confirm: async n => { askedOffline = n; return false; } });
    offline(false);
    // The same server, reached at another address.
    process.env.LT_SERVER = process.env.LT_SERVER.replace('127.0.0.1', 'localhost');
    let asked = null;
    const ok = await la.prepareLocalAccount(athlete, { confirm: async n => { asked = n; return false; } });
    await syncNow();
    return { offlineOk, askedOffline, ok, asked,
      server: (await web('phone', 'GET', '/api/programs')).filter(p => p.name === 'Made Before Moving').length };
  },

  // A session that has expired: the app opens on the cached account (its
  // own data), the sync signs out and keeps the queue, and signing back in
  // sends it.
  async expiredToken() {
    const platform = await import('./platform.mjs');
    const la = await import('../../src/lib/local-account.js');
    const { currentUser } = await import('../../src/stores/auth.js');
    const athlete = { id: Number(process.env.LT_PHONE_USER), username: 'athlete' };
    me();
    await la.prepareLocalAccount(athlete, { confirm: async () => true });
    await syncNow();
    offline(true);
    await api.createProgram({ name: 'Waiting Through Expiry' });
    offline(false);
    platform.setAuthToken(tokens.expired);
    currentUser.set(athlete);
    let asked = null;
    const ok = await la.prepareLocalAccount(athlete, { confirm: async n => { asked = n; return false; } });
    const r = await syncRaw();
    let user; currentUser.subscribe(v => { user = v; })();
    const queued = (await q(`SELECT COUNT(*) AS n FROM sync_queue`))[0].n;
    // Signs in again: same account, no question, the change goes up.
    platform.setAuthToken(tokens.phone);
    me();
    let asked2 = null;
    const ok2 = await la.prepareLocalAccount(athlete, { confirm: async n => { asked2 = n; return false; } });
    await syncNow();
    return { ok, asked, signedOut: !user, queuedAfter401: queued, ok2, asked2,
      server: (await web('phone', 'GET', '/api/programs')).filter(p => p.name === 'Waiting Through Expiry').length };
  },

  // Signing out part way through a sync never sends the rest under the
  // next account's session: the session is read once per sync.
  async signOutMidSync() {
    const platform = await import('./platform.mjs');
    const la = await import('../../src/lib/local-account.js');
    const athlete = { id: Number(process.env.LT_PHONE_USER) };
    me();
    await la.prepareLocalAccount(athlete, { confirm: async () => true });
    await syncNow();
    offline(true);
    for (let i = 0; i < 4; i++) await api.createProgram({ name: 'Mid ' + i });
    offline(false);
    const auths = [];
    let switched = false;
    globalThis.__httpHook = async (method, o) => {
      if (method === 'POST' && o.url.endsWith('/api/programs')) {
        auths.push(o.headers?.Authorization || '');
        if (!switched) { switched = true; platform.setAuthToken(tokens.other); localStorage.setItem('wl:userId', process.env.LT_OTHER_USER); }
      }
      return null;
    };
    await syncRaw();
    globalThis.__httpHook = null;
    return { sent: auths.length, allAthlete: auths.every(a => a === `Bearer ${tokens.phone}`),
      coachServer: (await web('other', 'GET', '/api/programs')).filter(p => p.name.startsWith('Mid ')).length };
  },

  // Disconnect, use the phone on its own, then sign in as another account:
  // the data is the phone's own after Disconnect, so no question, nothing lost.
  async disconnectThenOther() {
    const platform = await import('./platform.mjs');
    const la = await import('../../src/lib/local-account.js');
    const athlete = { id: Number(process.env.LT_PHONE_USER) }, coach = { id: Number(process.env.LT_OTHER_USER) };
    me();
    await la.prepareLocalAccount(athlete, { confirm: async () => true });
    await syncNow();
    await la.setLocalOwner();
    const srv = process.env.LT_SERVER;
    process.env.LT_SERVER = '';
    await api.createProgram({ name: 'Made On Its Own' });
    process.env.LT_SERVER = srv;
    platform.setAuthToken(tokens.other);
    localStorage.setItem('wl:userId', process.env.LT_OTHER_USER);
    let asked = null;
    const ok = await la.prepareLocalAccount(coach, { confirm: async n => { asked = n; return false; } });
    return { ok, asked, kept: names(await q(`SELECT name FROM programs WHERE name = 'Made On Its Own'`)) };
  },

  // Settings: Disconnect sends what's queued first and asks about what
  // can't go; Download over the phone's data clears it, asking first about
  // changes that never went up; neither drops them without a word.
  async settingsDownload() {
    const platform = await import('./platform.mjs');
    const la = await import('../../src/lib/local-account.js');
    const athlete = { id: Number(process.env.LT_PHONE_USER) }, coach = { id: Number(process.env.LT_OTHER_USER) };
    me();
    await la.prepareLocalAccount(athlete, { confirm: async () => true });
    await syncNow();
    offline(true);
    await api.createProgram({ name: 'Queued Before Disconnect' });
    // Disconnect with no connection: can't send, so it asks; saying no stops it.
    let asked = null;
    const stopped = await la.settleQueuedChanges('disconnect', { ask: async n => { asked = n; return false; } });
    const queueKept = (await q(`SELECT COUNT(*) AS n FROM sync_queue`))[0].n;
    offline(false);
    // Disconnect again, connected: it goes up first, nothing to ask.
    let asked2 = null;
    const went = await la.settleQueuedChanges('disconnect', { ask: async n => { asked2 = n; return false; } });
    await la.setLocalOwner();
    const onServer = (await web('phone', 'GET', '/api/programs')).filter(p => p.name === 'Queued Before Disconnect').length;
    // Local mode: the phone's own data, plus a write an older version left queued.
    const srv = process.env.LT_SERVER;
    process.env.LT_SERVER = '';
    await api.createProgram({ name: 'Standalone Before Download' });
    await sync.enqueueWrite('POST', '/api/programs', { name: 'Left In Queue' });
    // Settings > connect as the coach > Download.
    process.env.LT_SERVER = srv;
    platform.setAuthToken(tokens.other);
    localStorage.setItem('wl:userId', process.env.LT_OTHER_USER);
    await web('other', 'POST', '/api/programs', { name: 'Coach Server Plan' });
    let asked3 = null;
    const declined = await la.settleQueuedChanges('download', { send: false, ask: async n => { asked3 = n; return false; } });
    const stillThere = names(await q(`SELECT name FROM programs WHERE name = 'Standalone Before Download'`));
    const go = await la.settleQueuedChanges('download', { send: false, ask: async () => true });
    await la.claimForServer(process.env.LT_SERVER, coach.id, { clear: true });
    let asked4 = null;
    const signIn = await la.prepareLocalAccount(coach, { confirm: async n => { asked4 = n; return false; } });
    await syncNow();
    return {
      disconnect: { stopped, asked, queueKept, went, asked2, onServer },
      download: { declined, asked3, stillThere, go, signIn, asked4,
        phone: names(await q(`SELECT name FROM programs WHERE name IN ('Standalone Before Download', 'Coach Server Plan', 'Queued Before Disconnect') ORDER BY name`)),
        queue: (await q(`SELECT COUNT(*) AS n FROM sync_queue`))[0].n,
        leftSent: (await web('other', 'GET', '/api/programs')).filter(p => p.name === 'Left In Queue').length },
    };
  },

  // If the phone can't tell whose data it holds, it shows none of it, and
  // can try again.
  async gateError() {
    const la = await import('../../src/lib/local-account.js');
    const { get } = await import('svelte/store');
    const athlete = { id: Number(process.env.LT_PHONE_USER) };
    me();
    const db = await (await import('../../src/lib/db-native.js')).getDb();
    await db.execute('ALTER TABLE sync_meta RENAME TO sync_meta_away');
    const first = await la.ensureLocalAccount(athlete, { confirm: async () => true });
    const gate1 = get(la.accountGate);
    const shown1 = la.accountReadyFor(gate1, athlete.id);
    await db.execute('ALTER TABLE sync_meta_away RENAME TO sync_meta');
    const second = await la.ensureLocalAccount(athlete, { confirm: async () => true });
    return { first, state1: gate1.state, shown1, second, shown2: la.accountReadyFor(get(la.accountGate), athlete.id) };
  },

  // A slow link: the full pull is compressed and finishes; a pull given up
  // on here (still downloading natively) isn't started again on top of it.
  async slowLink() {
    me();
    const ex = [];
    for (let k = 0; k < 6; k++) ex.push(await web('phone', 'POST', '/api/exercises', { name: 'Ex ' + k }));
    for (let i = 0; i < 120; i++) {
      const d = new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString().slice(0, 10);
      await web('phone', 'PUT', '/api/workout/' + d, { name: 'Session ' + i, notes: 'notes about the session', exercises: ex.map((e, k) => ({ uuid: `u${i}-${k}`, exercise_id: e.id, name: e.name, sets: [1, 2, 3, 4].map(n => ({ uuid: `s${i}-${k}-${n}`, reps: 8, weight: 100 })) })) });
    }
    const RATE = 20000;   // bytes a second
    let wire = 0, raw = 0, pulls = 0, hang = false;
    globalThis.__httpHook = async (method, o) => {
      if (method !== 'GET' || !o.url.includes('/api/sync/pull')) return null;
      pulls++;
      if (hang) await new Promise(() => {});   // a native download that never ends
      const r = await realFetch(o.url, { headers: { ...o.headers, 'Accept-Encoding': 'gzip' } });
      const len = Number(r.headers.get('content-length')) || 0;
      const text = await r.text();
      wire = len || text.length; raw = text.length;
      await later(Math.round(wire / RATE * 1000));
      return { status: r.status, data: JSON.parse(text) };
    };
    globalThis.__ltDeadlineScale = 1 / 60;   // the pull's 10 minutes become 10 s
    const db = await import('../../src/lib/db-native.js');
    await db.setSyncMeta('full_pull', '1');
    const t0 = Date.now();
    const first = await syncRaw();
    const firstMs = Date.now() - t0;
    const fullPullAfter = await db.getSyncMeta('full_pull');
    // Now one that hangs: given up on after the deadline, and the next sync
    // doesn't start a second download beside it.
    globalThis.__ltDeadlineScale = 1 / 600;  // 1 s
    hang = true;
    await db.setSyncMeta('full_pull', '1');
    const before = pulls;
    const stuck = await syncRaw();
    const next = await syncRaw();
    return { firstOk: first.pull?.ok !== false, firstMs, wire, raw, fullPullAfter,
      stuckOk: stuck.pull?.ok !== false, nextOk: next.pull?.ok !== false, nativePullsStarted: pulls - before,
      workouts: (await q(`SELECT COUNT(*) AS n FROM workout_log`))[0].n };
  },

  // A day a coach prescribes from a program the athlete doesn't follow.
  async prescribed() {
    const plan = await web('other', 'POST', '/api/programs', { name: 'Rx Plan' });
    const day = await web('other', 'POST', '/api/templates', { program_id: plan.id, name: 'Rx Day', exercises: [{ name: 'Squat', sets: [{ reps: 5 }] }] });
    await later(1100);
    await syncNow();
    await later(1100);
    await web('other', 'POST', `/api/trainer/members/${process.env.LT_PHONE_USER}/prescriptions`, { template_id: day.id, date: '2026-10-07' });
    await syncNow();
    const open = async () => { try { const t = await api.getTemplate(day.id); return t ? `${t.name}: ${t.exercises.length}` : null; } catch (e) { return 'error ' + e.message; } };
    const online = await open();
    offline(true);
    return { online, offline: await open() };
  },

  // Another account signs in while a pull is still downloading: nothing of
  // the first account lands in the second one's copy, and the second still
  // gets its full pull.
  async accountRace() {
    const platform = await import('./platform.mjs');
    const la = await import('../../src/lib/local-account.js');
    const dbn = await import('../../src/lib/db-native.js');
    const athlete = { id: Number(process.env.LT_PHONE_USER) }, coach = { id: Number(process.env.LT_OTHER_USER) };
    await web('phone', 'PUT', '/api/workout/2026-09-01', { name: 'Athlete Session', exercises: [] });
    await web('phone', 'POST', '/api/programs', { name: 'Athlete Plan' });
    await web('phone', 'PUT', '/api/settings', { key: 'gotifyToken', value: 'athlete-secret' });
    await web('other', 'PUT', '/api/workout/2026-09-02', { name: 'Coach Session', exercises: [] });
    await web('other', 'POST', '/api/programs', { name: 'Coach Plan' });
    me();
    await la.prepareLocalAccount(athlete, { confirm: async () => true });
    let release;
    const held = new Promise(r => { release = r; });
    let entered = false;
    globalThis.__httpHook = async (method, o) => {
      if (method === 'GET' && o.url.includes('/api/sync/pull') && !entered) {
        entered = true;
        const r = await realFetch(o.url, { headers: o.headers });
        const t = await r.text();
        await held;   // the download is still going when the coach signs in
        return { status: r.status, data: JSON.parse(t) };
      }
      return null;
    };
    const first = sync.fullSync(true, true);
    await until(() => entered, 'the pull to start');
    platform.setAuthToken(tokens.other);
    localStorage.setItem('wl:userId', String(coach.id));
    const t0 = Date.now();
    const switched = await la.prepareLocalAccount(coach, { confirm: async () => true });
    const switchMs = Date.now() - t0;
    release();
    const r1 = await first;
    await later(200);
    globalThis.__httpHook = null;
    const afterRace = {
      workouts: names(await q(`SELECT name FROM workout_log ORDER BY name`)),
      programs: names(await q(`SELECT name FROM programs WHERE name LIKE '%Plan' ORDER BY name`)),
      setting: (await q(`SELECT value FROM user_settings WHERE key = 'gotifyToken'`)).length,
      fullPull: await dbn.getSyncMeta('full_pull'),
    };
    await syncNow();
    return {
      switched, quick: switchMs < 10000, r1: { ok: r1.ok, reason: r1.reason ?? r1.pull?.reason ?? null }, afterRace,
      coachPhone: {
        workouts: names(await q(`SELECT name FROM workout_log ORDER BY name`)),
        programs: names(await q(`SELECT name FROM programs WHERE name LIKE '%Plan' ORDER BY name`)),
        setting: (await q(`SELECT value FROM user_settings WHERE key = 'gotifyToken'`)).length,
      },
    };
  },

  // Synced to one server, Disconnect, a workout logged on the phone alone,
  // then Upload to another server: everything goes up, the dialog counted
  // exactly that, and nothing leaves the phone before it's on the server.
  async uploadAfterDisconnect() {
    const platform = await import('./platform.mjs');
    const la = await import('../../src/lib/local-account.js');
    const athlete = { id: Number(process.env.LT_PHONE_USER) };
    const serverB = process.env.LT_SERVER_B, tokensB = JSON.parse(process.env.LT_TOKENS_B || '{}');
    const webB = async (method, path, body) => {
      const r = await realFetch(serverB + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokensB.phone}` }, body: body ? JSON.stringify(body) : undefined });
      const t = await r.text();
      if (!r.ok) throw new Error(`${method} ${path} ${r.status} ${t.slice(0, 120)}`);
      return t ? JSON.parse(t) : null;
    };
    const plan = await web('phone', 'POST', '/api/programs', { name: 'A Plan' });
    await web('phone', 'POST', '/api/templates', { program_id: plan.id, name: 'A Day', exercises: [] });
    await web('phone', 'PUT', '/api/workout/2026-08-01', { name: 'A Session', exercises: [{ uuid: 'e1', name: 'Squat', sets: [{ uuid: 's1', reps: 5, weight: 100 }] }] });
    await web('phone', 'PUT', '/api/body-stats/2026-08-01', { stats: { weight: 80 } });
    me();
    await la.prepareLocalAccount(athlete, { confirm: async () => true });
    await syncNow();
    // Settings > Disconnect.
    await la.settleQueuedChanges('disconnect', { ask: async () => true });
    await la.setLocalOwner();
    process.env.LT_SERVER = '';
    platform.setAuthToken(null);
    const afterDisconnect = {
      workouts: (await q(`SELECT name, id < 0 AS own FROM workout_log ORDER BY name`)).map(r => `${r.name} ${r.own ? 'own' : 'server'}`),
      programs: names(await q(`SELECT name FROM programs WHERE name LIKE 'A %' ORDER BY name`)),
    };
    await api.saveWorkout('2026-08-05', { name: 'Local Session', exercises: [] });
    // Settings > connect to server B > Upload.
    process.env.LT_SERVER = serverB;
    platform.setAuthToken(tokensB.phone);
    localStorage.setItem('wl:userId', process.env.LT_B_USER);
    const { countLocalData, uploadLocalToServer } = await import('../../src/lib/migrate.js');
    const counts = await countLocalData();
    const sum = await uploadLocalToServer();
    await la.claimForServer(serverB, Number(process.env.LT_B_USER), { clear: false });
    await syncNow(); await syncNow();
    const onB = [];
    for (const d of ['2026-08-01', '2026-08-05']) onB.push(...((await webB('GET', `/api/workout/${d}/sessions`)).sessions || []).map(s => s.name));
    const bPlan = (await webB('GET', '/api/programs')).find(p => p.name === 'A Plan');
    return {
      afterDisconnect,
      counts: { w: counts.workouts, p: counts.programs, t: counts.templates, b: counts.bodyStats },
      uploaded: { w: sum.success.workouts, p: sum.success.programs, t: sum.success.templates, b: sum.success.bodyStats },
      errors: sum.errors.length,
      onB: {
        workouts: onB.sort(),
        days: bPlan ? (await webB('GET', `/api/programs/${bPlan.id}`)).templates.map(t => t.name) : [],
        weight: (await webB('GET', '/api/body-stats/2026-08-01')).stats?.stats?.weight ?? null,
      },
      phone: {
        workouts: names(await q(`SELECT name FROM workout_log ORDER BY name`)),
        programs: names(await q(`SELECT name FROM programs WHERE name LIKE 'A %' ORDER BY name`)),
        days: names(await q(`SELECT name FROM workout_templates WHERE name = 'A Day'`)),
      },
    };
  },

  // A pulled deletion never takes a row only this phone has, or one with a
  // change made here still on its way up.
  async pulledDeletes() {
    const platform = await import('./platform.mjs');
    const srv = process.env.LT_SERVER;
    // Made on the phone alone; its upload fails, so it stays here only.
    process.env.LT_SERVER = '';
    platform.setAuthToken(null);
    await api.saveWorkout('2026-07-01', { name: 'Local Keep', exercises: [{ uuid: 'r1', name: 'Row', sets: [{ uuid: 'r2', reps: 8, weight: 40 }] }] });
    const localIds = (await q(`SELECT id FROM workout_log`)).map(r => r.id);
    process.env.LT_SERVER = srv;
    platform.setAuthToken(tokens.phone);
    me();
    // On the web meanwhile: sessions made and deleted under this account,
    // with the ids the phone's own row had.
    for (let i = 0; i < 3; i++) {
      await web('phone', 'PUT', `/api/workout/2026-06-0${i + 1}`, { name: 'Web Gone ' + i, exercises: [] });
      await web('phone', 'DELETE', `/api/workout/2026-06-0${i + 1}`);
    }
    globalThis.__fetchHook = (u, i) => (/\/api\/workout\//.test(String(u)) && i?.method === 'PUT')
      ? Promise.resolve(new Response(JSON.stringify({ error: 'boom' }), { status: 500 })) : null;
    const { uploadLocalToServer } = await import('../../src/lib/migrate.js');
    const sum = await uploadLocalToServer();
    globalThis.__fetchHook = null;
    const la = await import('../../src/lib/local-account.js');
    await la.claimForServer(srv, Number(process.env.LT_PHONE_USER), { clear: false });
    await syncNow();
    const localOnly = (await q(`SELECT name, sync_state FROM workout_log WHERE name = 'Local Keep'`)).map(r => `${r.name} ${r.sync_state}`);
    // A server program edited here while its change can't go up yet; on the
    // web it is deleted meanwhile. And a workout edited the same way.
    const plan = await web('phone', 'POST', '/api/programs', { name: 'Edited Here' });
    const w = (await web('phone', 'PUT', '/api/workout/2026-07-10', { name: 'Edited Session', exercises: [] })).workout;
    await syncNow();
    globalThis.__httpHook = async (method, o) => (method === 'PUT' ? { status: 503, data: { error: 'busy' } } : null);
    offline(true);
    await api.updateProgram(plan.id, { name: 'Edited Here, renamed' });
    await api.saveWorkout('2026-07-10', { id: w.id, name: 'Edited Session, renamed', exercises: [] });
    offline(false);
    await web('phone', 'DELETE', `/api/programs/${plan.id}`);
    await web('phone', 'DELETE', `/api/workout/2026-07-10?id=${w.id}`);
    await syncRaw();   // the changes can't go up; the pull brings the deletions
    globalThis.__httpHook = null;
    return {
      localIds, uploadErrors: sum.errors.length, localOnly,
      whileWaiting: {
        program: names(await q(`SELECT name FROM programs WHERE id = ?`, [plan.id])),
        workout: names(await q(`SELECT name FROM workout_log WHERE id = ?`, [w.id])),
      },
    };
  },

  // A copy an earlier version kept: a program it made offline (its create
  // queued without saying which row), a server row it edited offline (left
  // marked changed), and a row made before connecting under a number the
  // server also uses for another of this account's rows.
  async legacyUpgrade() {
    const dbn = await import('../../src/lib/db-native.js');
    me();
    await web('phone', 'POST', '/api/programs', { name: 'Server Plan One' });
    const two = await web('phone', 'POST', '/api/programs', { name: 'Server Plan Two' });
    const three = await web('phone', 'POST', '/api/programs', { name: 'Server Plan Three' });
    await web('phone', 'POST', '/api/programs', { name: 'Already Up' });
    await syncNow();
    // Back to what the earlier version left: no owner tag, ids not sorted out.
    await dbn.dbRun(`DELETE FROM sync_meta WHERE key IN ('account', 'local_ids')`, []);
    const next = ((await q(`SELECT MAX(id) AS m FROM programs`))[0].m || 0) + 1;
    await dbn.dbRun(`INSERT INTO programs (id, name, goal, created_by, visibility, duration_weeks, advance_mode, on_complete, created_at, updated_at, sync_state)
      VALUES (?, 'Legacy Plan', 'general', ?, 'private', 1, 'sessions', 'hold', '2026-10-01T10:00:00.000Z', '2026-10-01T10:00:00.000Z', 'pending')`, [next, Number(process.env.LT_PHONE_USER)]);
    await sync.enqueueWrite('POST', '/api/programs', { name: 'Legacy Plan' });
    await dbn.dbRun(`UPDATE programs SET name = 'Server Plan One', sync_state = 'pending' WHERE name = 'Server Plan One'`, []);
    await dbn.dbRun(`UPDATE programs SET name = 'Phone Only Plan', created_at = '2020-01-01T00:00:00.000Z', sync_state = 'pending' WHERE id = ?`, [two.id]);
    // A row with no time it was made, under a number the server uses: not
    // taken for the server's row.
    await dbn.dbRun(`UPDATE programs SET name = 'No Time Plan', created_at = NULL, sync_state = 'pending' WHERE id = ?`, [three.id]);
    // A program made offline whose create went up (the earlier version never
    // learned the server's id): the server's "Already Up" is that row.
    const upId = ((await q(`SELECT MAX(id) AS m FROM programs`))[0].m || 0) + 1;
    await dbn.dbRun(`INSERT INTO programs (id, name, description, goal, created_by, visibility, duration_weeks, advance_mode, on_complete, created_at, updated_at, sync_state)
      VALUES (?, 'Already Up', NULL, 'general', ?, 'private', 1, 'sessions', 'hold', '2026-09-01T10:00:00.000Z', '2026-09-01T10:00:00.000Z', 'pending')`, [upId, Number(process.env.LT_PHONE_USER)]);
    await syncNow(); await syncNow();
    const phone = await q(`SELECT id, name, sync_state FROM programs WHERE name IN ('Legacy Plan', 'Server Plan One', 'Server Plan Two', 'Phone Only Plan', 'Server Plan Three', 'No Time Plan', 'Already Up') ORDER BY name`);
    const server = (await web('phone', 'GET', '/api/programs')).map(p => p.name);
    return {
      phone: phone.map(r => `${r.name} ${r.id > 0 ? 'server' : 'own'} ${r.sync_state}`),
      serverLegacy: server.filter(n => n === 'Legacy Plan').length,
      serverTwo: server.filter(n => n === 'Server Plan Two').length,
      serverUp: server.filter(n => n === 'Already Up').length,
      flag: await dbn.getSyncMeta('local_ids'),
      refused,
    };
  },

  // A create whose answer was lost: the pull brings the server's copy, which
  // is then edited offline. Sent again, it finds that same row: one copy.
  async lostAnswerEdit() {
    me();
    await syncNow();
    offline(true);
    await api.createProgram({ name: 'Phone Plan' });
    offline(false);
    let drop = 1;
    globalThis.__httpHook = async (method, o) => {
      if (drop > 0 && method === 'POST' && /\/api\/programs$/.test(o.url)) {
        drop--;
        await realFetch(o.url, { method, headers: o.headers, body: JSON.stringify(o.data) });
        throw new TypeError('Failed to fetch');
      }
      return null;
    };
    await syncRaw();
    globalThis.__httpHook = null;
    const pulled = (await q(`SELECT id FROM programs WHERE name = 'Phone Plan' AND id > 0`))[0];
    offline(true);
    await api.updateProgram(pulled.id, { name: 'Phone Plan edited' });
    offline(false);
    await syncNow(); await syncNow();
    return {
      phone: names(await q(`SELECT name FROM programs WHERE name LIKE 'Phone Plan%' ORDER BY name`)),
      server: (await web('phone', 'GET', '/api/programs')).filter(p => p.name.startsWith('Phone Plan')).map(p => p.name),
      queue: (await q(`SELECT COUNT(*) AS n FROM sync_queue`))[0].n,
    };
  },

  // What the app holds in memory for one account (setting stores, the
  // workout on show) is gone when another signs in, and never saved as the
  // next one's.
  async storesReset() {
    const platform = await import('./platform.mjs');
    const la = await import('../../src/lib/local-account.js');
    const { get } = await import('svelte/store');
    const st = await import('../../src/stores/settings.js');
    const wk = await import('../../src/stores/workout.js');
    const athlete = { id: Number(process.env.LT_PHONE_USER) }, coach = { id: Number(process.env.LT_OTHER_USER) };
    me();
    await la.prepareLocalAccount(athlete, { confirm: async () => true });
    await syncNow();
    st.gotifyToken.set('athlete-secret');
    st.radioPassword.set('athlete-radio');
    st.favoriteExercises.set([101]);
    st.restPerExercise.set({ 101: 90 });
    const settings = async (who) => web(who, 'GET', '/api/settings');
    await until(async () => (await settings('phone')).restPerExercise?.['101'] === 90, 'the athlete\'s settings to save');
    wk.todayLog.set({ name: 'Athlete Workout', exercises: [] });
    // Changed just before the switch: still waiting to be sent.
    st.gotifyToken.set('athlete-late');
    // The coach signs in on this phone.
    platform.setAuthToken(tokens.other);
    localStorage.setItem('wl:userId', String(coach.id));
    await la.prepareLocalAccount(coach, { confirm: async () => true });
    const seen = {
      gotify: get(st.gotifyToken), radio: get(st.radioPassword), favorites: get(st.favoriteExercises),
      rest: get(st.restPerExercise), workout: get(wk.todayLog),
    };
    // What the rest timer does at the end of a rest: its value, plus one.
    st.restPerExercise.set({ ...get(st.restPerExercise), 202: 60 });
    await until(async () => (await settings('other')).restPerExercise?.['202'] === 60, 'the coach\'s rest to save');
    await later(1200);
    const coachServer = await settings('other');
    // And signing out (stores/auth.js) clears them as well.
    const auth = await import('../../src/stores/auth.js');
    st.ntfyToken.set('coach-ntfy');
    await auth.logout();
    return {
      seen,
      coachServer: { gotify: coachServer.gotifyToken ?? null, radio: coachServer.radioPassword ?? null, favorites: coachServer.favoriteExercises ?? null, rest: coachServer.restPerExercise },
      athleteServer: (await settings('phone')).gotifyToken,
      afterSignOut: get(st.ntfyToken),
    };
  },

  // Synced, Disconnect, a change and a new workout while disconnected, then
  // the same account on the same server again with Upload: everything once.
  async sameAccountUpload() {
    const platform = await import('./platform.mjs');
    const la = await import('../../src/lib/local-account.js');
    const srv = process.env.LT_SERVER;
    const athlete = { id: Number(process.env.LT_PHONE_USER) };
    const plan = await web('phone', 'POST', '/api/programs', { name: 'S Plan' });
    await web('phone', 'POST', '/api/templates', { program_id: plan.id, name: 'S Day', exercises: [] });
    const curl = await web('phone', 'POST', '/api/exercises', { name: 'S Curl' });
    await web('phone', 'PUT', '/api/workout/2026-08-01', { name: 'S Session', exercises: [{ uuid: 'e1', exercise_id: curl.id, name: 'S Curl', sets: [{ uuid: 's1', reps: 5, weight: 100 }] }] });
    await web('phone', 'PUT', '/api/workout/2026-08-02', { name: 'B Session', exercises: [{ uuid: 'e2', name: 'Bench', sets: [{ uuid: 's2', reps: 5, weight: 60 }] }] });
    await web('phone', 'POST', '/api/cardio', { date: '2026-08-01', activity: 'Server Row', duration_min: 20 });
    me();
    await la.prepareLocalAccount(athlete, { confirm: async () => true });
    await syncNow();
    await la.settleQueuedChanges('disconnect', { ask: async () => true });
    await la.setLocalOwner();
    process.env.LT_SERVER = '';
    platform.setAuthToken(null);
    const own = (await q(`SELECT id FROM programs WHERE name = 'S Plan'`))[0];
    await api.updateProgram(own.id, { name: 'S Plan renamed here' });
    await api.saveWorkout('2026-08-05', { name: 'Offline Session', exercises: [] });
    await api.createCardio({ date: '2026-08-05', activity: 'Phone Row', duration_min: 25 });
    process.env.LT_SERVER = srv;
    platform.setAuthToken(tokens.phone);
    me();
    const { countLocalData, uploadLocalToServer } = await import('../../src/lib/migrate.js');
    const counts = await countLocalData();
    const sum = await uploadLocalToServer();
    await la.claimForServer(srv, athlete.id, { clear: false });
    await syncNow(); await syncNow();
    const sess = [];
    for (const d of ['2026-08-01', '2026-08-02', '2026-08-05']) sess.push(...((await web('phone', 'GET', `/api/workout/${d}/sessions`)).sessions || []).map(s => s.name));
    const progs = (await web('phone', 'GET', '/api/programs')).filter(p => p.name.startsWith('S Plan'));
    return {
      counts: { w: counts.workouts, p: counts.programs, c: counts.cardio },
      uploaded: { w: sum.success.workouts, p: sum.success.programs, c: sum.success.cardio }, errors: sum.errors.length,
      server: {
        sessions: sess.sort(), plans: progs.map(p => p.name),
        days: progs[0] ? (await web('phone', 'GET', `/api/programs/${progs[0].id}`)).templates.map(t => t.name) : [],
        curls: (await web('phone', 'GET', '/api/exercises')).filter(e => e.name === 'S Curl').length,
        cardio: (await web('phone', 'GET', '/api/cardio')).map(c => c.activity).sort(),
      },
      phone: {
        sessions: names(await q(`SELECT name FROM workout_log ORDER BY name`)),
        plans: (await q(`SELECT name, id > 0 AS server FROM programs WHERE name LIKE 'S Plan%'`)).map(r => `${r.name} ${r.server ? 'server' : 'own'}`),
        curlRef: (await q(`SELECT exercises FROM workout_log WHERE name = 'S Session'`)).map(r => JSON.parse(r.exercises)[0]?.exercise_id === curl.id),
      },
      queue: (await q(`SELECT COUNT(*) AS n FROM sync_queue`))[0].n,
    };
  },

  // Disconnect stopped part way (the app killed, an error), at several
  // points: the copy is as it was, still the account's, and syncs with no
  // duplicates; Disconnect again then works.
  async disconnectKilled() {
    const la = await import('../../src/lib/local-account.js');
    const dbn = await import('../../src/lib/db-native.js');
    const athlete = { id: Number(process.env.LT_PHONE_USER) };
    const plan = await web('phone', 'POST', '/api/programs', { name: 'K Plan' });
    for (let i = 0; i < 3; i++) await web('phone', 'POST', '/api/templates', { program_id: plan.id, name: 'K Day ' + i, exercises: [] });
    for (let d = 1; d <= 4; d++) await web('phone', 'PUT', `/api/workout/2026-03-0${d}`, { name: 'K' + d, program_id: plan.id, exercises: [] });
    me();
    await la.prepareLocalAccount(athlete, { confirm: async () => true });
    await syncNow();
    const state = async () => ({
      plans: (await q(`SELECT id, name FROM programs WHERE name LIKE 'K Plan%'`)).map(r => `${r.name} ${r.id > 0 ? 'server' : 'own'}`),
      orphanDays: (await q(`SELECT COUNT(*) AS n FROM workout_templates t WHERE t.name LIKE 'K Day%' AND NOT EXISTS (SELECT 1 FROM programs p WHERE p.id = t.program_id)`))[0].n,
      danglingWorkouts: (await q(`SELECT COUNT(*) AS n FROM workout_log w WHERE w.program_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM programs p WHERE p.id = w.program_id)`))[0].n,
      ownRows: (await q(`SELECT (SELECT COUNT(*) FROM programs WHERE id < 0) + (SELECT COUNT(*) FROM workout_templates WHERE id < 0) + (SELECT COUNT(*) FROM workout_log WHERE id < 0) AS n`))[0].n,
      owner: JSON.parse(await dbn.getSyncMeta('account') || 'null')?.u ?? null,
      origins: (await q(`SELECT COUNT(*) AS n FROM row_origin`).catch(() => [{ n: null }]))[0].n,
    });
    const points = {
      first: (sql) => /^INSERT INTO id_remap/.test(sql),
      days: (sql) => /^UPDATE workout_templates SET program_id/.test(sql),
      ids: (sql) => /^UPDATE programs SET id/.test(sql),
      tag: (sql, n) => /^INSERT OR REPLACE INTO sync_meta/.test(sql) && n > 5,
    };
    const killed = {};
    for (const [at, when] of Object.entries(points)) {
      globalThis.__dbKill = when;
      let err = null;
      try { await la.setLocalOwner(); } catch (e) { err = e.message; }
      globalThis.__dbKill = null;
      await syncNow();
      killed[at] = { err, ...(await state()) };
    }
    // Still connected: a rename goes to the server's plan, once.
    const p = (await q(`SELECT id FROM programs WHERE name = 'K Plan'`))[0];
    await api.updateProgram(p.id, { name: 'K Plan renamed' });
    await syncNow();
    await la.setLocalOwner();
    return {
      killed, after: await state(),
      server: (await web('phone', 'GET', '/api/programs')).filter(x => x.name.startsWith('K Plan')).map(x => x.name),
    };
  },

  // A sync (the 30-second poll) starts while Disconnect is moving the rows.
  async syncDuringDisconnect() {
    const la = await import('../../src/lib/local-account.js');
    const gen = await import('../../src/lib/account-gen.js');
    const athlete = { id: Number(process.env.LT_PHONE_USER) };
    const ps = [];
    for (let i = 0; i < 4; i++) {
      ps.push(await web('phone', 'POST', '/api/programs', { name: 'P' + i }));
      for (let j = 0; j < 2; j++) await web('phone', 'POST', '/api/templates', { program_id: ps[i].id, name: `P${i} D${j}`, exercises: [] });
    }
    for (let d = 1; d <= 9; d++) await web('phone', 'PUT', `/api/workout/2026-05-0${d}`, { name: 'W' + d, program_id: ps[0].id, exercises: [] });
    me();
    await la.prepareLocalAccount(athlete, { confirm: async () => true });
    await syncNow();
    await web('phone', 'PUT', `/api/programs/${ps[0].id}`, { name: 'P0 renamed on the web' });
    await la.settleQueuedChanges('disconnect', { ask: async () => true });
    globalThis.__dbJitter = 8;
    const disc = la.setLocalOwner();
    await until(async () => gen.copyMoving?.() || (await q(`SELECT 1 FROM programs WHERE id < 0`)).length, 'Disconnect to start');
    const poll = await sync.fullSync(true, true);
    await disc;
    globalThis.__dbJitter = 0;
    return {
      poll: { ok: poll.ok, reason: poll.reason ?? null },
      programs: (await q(`SELECT name, id < 0 AS own FROM programs WHERE name LIKE 'P%' ORDER BY name`)).map(r => `${r.name} ${r.own ? 'own' : 'server'}`),
      serverRows: (await q(`SELECT (SELECT COUNT(*) FROM programs WHERE id > 0 AND name LIKE 'P%') + (SELECT COUNT(*) FROM workout_log WHERE id > 0) AS n`))[0].n,
    };
  },

  // Disconnect on a big account: how many statements, and every reference
  // follows (workouts, program workouts, a coach's prescription).
  async bigDisconnect() {
    const la = await import('../../src/lib/local-account.js');
    const dbn = await import('../../src/lib/db-native.js');
    const athlete = { id: Number(process.env.LT_PHONE_USER) };
    me();
    await la.prepareLocalAccount(athlete, { confirm: async () => true });
    await syncNow();
    const N = 1500, E = 40;
    for (let i = 1; i <= E; i++) await dbn.dbRun(`INSERT INTO exercises (id, name, source, is_global, sync_state, created_by) VALUES (?, ?, 'custom', 0, 'clean', ?)`, [100000 + i, 'Big Ex ' + i, athlete.id]);
    for (let p = 1; p <= 15; p++) {
      await dbn.dbRun(`INSERT INTO programs (id, name, created_by, visibility, sync_state) VALUES (?, ?, ?, 'private', 'clean')`, [5000 + p, 'Big P' + p, athlete.id]);
      for (let d = 1; d <= 5; d++) await dbn.dbRun(`INSERT INTO workout_templates (id, program_id, name, exercises, sync_state) VALUES (?, ?, ?, ?, 'clean')`, [50000 + p * 10 + d, 5000 + p, 'D' + d, JSON.stringify([{ exercise_id: 100001 + d, sets: 3 }])]);
    }
    for (let i = 0; i < N; i++) {
      const date = new Date(Date.UTC(2020, 0, 1) + i * 86400000).toISOString().slice(0, 10);
      const exs = [0, 1, 2, 3, 4, 5].map(k => ({ exercise_id: 100001 + ((i + k) % E), uuid: `u${i}-${k}`, sets: [{ uuid: `s${i}-${k}`, reps: 5, weight: 100 + k }] }));
      await dbn.dbRun(`INSERT INTO workout_log (id, user_id, date, name, exercises, program_id, template_id, sync_state, created_at) VALUES (?, 1, ?, ?, ?, ?, ?, 'clean', ?)`, [200000 + i, date, 'BW' + i, JSON.stringify(exs), 5001, 50011, date]);
      if (i % 3 === 0) await dbn.dbRun(`INSERT INTO body_stats_log (id, user_id, date, stats, sync_state) VALUES (?, 1, ?, '{"weight":80}', 'clean')`, [300000 + i, date]);
    }
    await dbn.dbRun(`INSERT INTO coach_prescriptions (id, trainer_id, member_id, date, template_id, name, exercises) VALUES (900, 1, ?, '2026-01-01', 50011, 'Rx', ?)`, [athlete.id, JSON.stringify([{ exercise_id: 100001, name: 'Big Ex 1' }])]);
    await dbn.dbRun(`INSERT INTO user_settings (user_id, key, value) VALUES (1, 'favoriteExercises', '[100001,100002]')`, []);
    globalThis.__dbStats = { calls: 0, statements: 0 };
    const t0 = Date.now();
    await la.setLocalOwner();
    const ms = Date.now() - t0;
    const stats = globalThis.__dbStats;
    const ex1 = (await q(`SELECT id FROM exercises WHERE name = 'Big Ex 1'`))[0].id;
    const p1 = (await q(`SELECT id FROM programs WHERE name = 'Big P1'`))[0].id;
    const d11 = (await q(`SELECT id FROM workout_templates WHERE program_id = ? AND name = 'D1'`, [p1]))[0].id;
    const w0 = (await q(`SELECT * FROM workout_log WHERE name = 'BW0'`))[0];
    return {
      rows: N, calls: stats.calls, statements: stats.statements, ms,
      own: (await q(`SELECT (SELECT COUNT(*) FROM workout_log WHERE id > 0) + (SELECT COUNT(*) FROM programs WHERE id > 0 AND name LIKE 'Big%') + (SELECT COUNT(*) FROM exercises WHERE id > 0 AND is_global = 0) AS n`))[0].n === 0,
      workoutRefs: w0.program_id === p1 && w0.template_id === d11 && JSON.parse(w0.exercises)[0].exercise_id === ex1,
      rxRefs: (await q(`SELECT template_id, exercises FROM coach_prescriptions WHERE id = 900`)).map(r => r.template_id === d11 && JSON.parse(r.exercises)[0].exercise_id === ex1)[0],
      favorites: JSON.parse((await q(`SELECT value FROM user_settings WHERE key = 'favoriteExercises'`))[0].value).includes(ex1),
      unchangedSets: JSON.parse(w0.exercises)[0].sets[0].weight === 100,
    };
  },

  // The account check and a sync claim the same copy at once.
  async claimRace() {
    const platform = await import('./platform.mjs');
    const la = await import('../../src/lib/local-account.js');
    const dbn = await import('../../src/lib/db-native.js');
    const srv = process.env.LT_SERVER;
    const athlete = { id: Number(process.env.LT_PHONE_USER) };
    const rounds = [];
    for (let round = 0; round < 4; round++) {
      // A fresh copy made standalone, never connected.
      await dbn.dbClearUserData();
      await dbn.dbRun(`DELETE FROM sync_meta WHERE key IN ('account', 'local_ids', 'full_pull')`, []);
      process.env.LT_SERVER = '';
      platform.setAuthToken(null);
      for (let i = 0; i < 3; i++) {
        const p = await api.createProgram({ name: `G${round}${i}` });
        for (let j = 0; j < 3; j++) {
          const d = await api.createTemplate({ program_id: p.id, name: `G${round}${i} D${j}`, exercises: [] });
          await api.saveWorkout(`2026-04-${10 + i * 3 + j}`, { name: `GW${round}${i}${j}`, program_id: p.id, template_id: d.id, exercises: [] });
        }
      }
      process.env.LT_SERVER = srv;
      platform.setAuthToken(tokens.phone);
      me();
      globalThis.__dbJitter = 10;
      await Promise.all([la.prepareLocalAccount(athlete, { confirm: async () => true }), la.localDataIsThisAccount()]);
      globalThis.__dbJitter = 0;
      rounds.push({
        own: (await q(`SELECT COUNT(*) AS n FROM programs WHERE name LIKE 'G%' AND id < 0`))[0].n,
        orphanDays: (await q(`SELECT COUNT(*) AS n FROM workout_templates t WHERE name LIKE 'G%' AND NOT EXISTS (SELECT 1 FROM programs p WHERE p.id = t.program_id)`))[0].n,
        danglingProgram: (await q(`SELECT COUNT(*) AS n FROM workout_log w WHERE w.program_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM programs p WHERE p.id = w.program_id)`))[0].n,
        danglingDay: (await q(`SELECT COUNT(*) AS n FROM workout_log w WHERE w.template_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM workout_templates t WHERE t.id = w.template_id)`))[0].n,
      });
    }
    return rounds;
  },

  // An athlete's save still out when the coach signs in, then the network
  // drops it.
  async writeDuringSwitch() {
    const platform = await import('./platform.mjs');
    const la = await import('../../src/lib/local-account.js');
    const athlete = { id: Number(process.env.LT_PHONE_USER) }, coach = { id: Number(process.env.LT_OTHER_USER) };
    me();
    await la.prepareLocalAccount(athlete, { confirm: async () => true });
    await syncNow();
    let release;
    const held = new Promise(r => { release = r; });
    let entered = false;
    globalThis.__fetchHook = (u, i) => {
      if (/\/api\/body-stats\//.test(String(u)) && i?.method === 'PUT') { entered = true; return held.then(() => { throw new TypeError('Failed to fetch'); }); }
      return null;
    };
    const write = api.saveBodyStats('2026-02-03', { stats: { weight: 99.9 } }).catch(e => 'refused: ' + e.message);
    await until(() => entered, 'the save to be out');
    platform.setAuthToken(tokens.other);
    localStorage.setItem('wl:userId', String(coach.id));
    await la.prepareLocalAccount(coach, { confirm: async () => true });
    release();
    await write;
    globalThis.__fetchHook = null;
    const queue = (await q(`SELECT payload FROM sync_queue`)).map(r => JSON.parse(r.payload).path);
    const local = (await q(`SELECT date FROM body_stats_log WHERE date = '2026-02-03'`)).length;
    await syncNow();
    return { queue, local, coachServer: (await web('other', 'GET', '/api/body-stats/2026-02-03'))?.stats?.stats ?? null };
  },

  // A copy from an earlier version: the server's "Push" edited offline (its
  // edit queued), and a new "Push" made offline with a day.
  async legacySameName() {
    const dbn = await import('../../src/lib/db-native.js');
    me();
    const push = await web('phone', 'POST', '/api/programs', { name: 'Push' });
    await web('phone', 'POST', '/api/templates', { program_id: push.id, name: 'Server Push Day' });
    await syncNow();
    await dbn.dbRun(`DELETE FROM sync_meta WHERE key IN ('account', 'local_ids')`, []);
    await dbn.dbRun(`UPDATE programs SET description = 'edited offline', sync_state = 'pending' WHERE id = ?`, [push.id]);
    await sync.enqueueWrite('PUT', `/api/programs/${push.id}`, { name: 'Push', description: 'edited offline' });
    const next = ((await q(`SELECT MAX(id) AS m FROM programs`))[0].m || 0) + 1;
    await dbn.dbRun(`INSERT INTO programs (id, name, goal, created_by, visibility, duration_weeks, advance_mode, on_complete, created_at, updated_at, sync_state)
      VALUES (?, 'Push', 'general', ?, 'private', 1, 'sessions', 'hold', '2026-10-01T10:00:00.000Z', '2026-10-01T10:00:00.000Z', 'pending')`, [next, Number(process.env.LT_PHONE_USER)]);
    await sync.enqueueWrite('POST', '/api/programs', { name: 'Push' });
    const tnext = ((await q(`SELECT MAX(id) AS m FROM workout_templates`))[0].m || 0) + 1;
    await dbn.dbRun(`INSERT INTO workout_templates (id, program_id, name, exercises, created_at, updated_at, sync_state) VALUES (?, ?, 'New Push Day', '[]', '2026-10-01T10:00:01.000Z', '2026-10-01T10:00:01.000Z', 'pending')`, [tnext, next]);
    await sync.enqueueWrite('POST', '/api/templates', { program_id: next, name: 'New Push Day', exercises: [] });
    await syncNow(); await syncNow();
    const sp = (await web('phone', 'GET', '/api/programs')).filter(p => p.name === 'Push');
    const server = [];
    for (const p of sp) { const f = await web('phone', 'GET', `/api/programs/${p.id}`); server.push(`${p.description || '-'} [${f.templates.map(t => t.name).join(',')}]`); }
    const phone = [];
    for (const p of await q(`SELECT id, description FROM programs WHERE name = 'Push'`)) phone.push(`${p.description || '-'} [${(await q(`SELECT name FROM workout_templates WHERE program_id = ?`, [p.id])).map(t => t.name).join(',')}]`);
    return { server: server.sort(), phone: phone.sort(), queue: (await q(`SELECT COUNT(*) AS n FROM sync_queue`))[0].n, refused };
  },

  // Upload where one program workout fails: it goes up later, no copy is
  // left twice on the phone.
  async uploadPartialDay() {
    const platform = await import('./platform.mjs');
    const la = await import('../../src/lib/local-account.js');
    const srv = process.env.LT_SERVER;
    process.env.LT_SERVER = '';
    platform.setAuthToken(null);
    const p = await api.createProgram({ name: 'U Plan' });
    await api.createTemplate({ program_id: p.id, name: 'U D1', exercises: [] });
    await api.createTemplate({ program_id: p.id, name: 'U D2', exercises: [] });
    process.env.LT_SERVER = srv;
    platform.setAuthToken(tokens.phone);
    me();
    globalThis.__fetchHook = (u, i) => (/\/api\/templates$/.test(String(u)) && i?.method === 'POST' && String(i.body).includes('U D2'))
      ? Promise.resolve(new Response(JSON.stringify({ error: 'boom' }), { status: 500 })) : null;
    const { uploadLocalToServer } = await import('../../src/lib/migrate.js');
    const sum = await uploadLocalToServer();
    globalThis.__fetchHook = null;
    await la.claimForServer(srv, Number(process.env.LT_PHONE_USER), { clear: false });
    await syncNow(); await syncNow();
    const sp = (await web('phone', 'GET', '/api/programs')).filter(x => x.name === 'U Plan');
    return {
      errors: sum.errors.map(e => e.name),
      server: { plans: sp.length, days: sp[0] ? (await web('phone', 'GET', `/api/programs/${sp[0].id}`)).templates.map(t => t.name).sort() : [] },
      phone: { plans: (await q(`SELECT COUNT(*) AS n FROM programs WHERE name = 'U Plan'`))[0].n, days: names(await q(`SELECT name FROM workout_templates WHERE name LIKE 'U D%' ORDER BY name`)) },
      queue: (await q(`SELECT COUNT(*) AS n FROM sync_queue`))[0].n,
    };
  },

  // The same user id on a server that can't say which it is, at another
  // address: asked, never decided silently. Then: another account's
  // servers that both say who they are; a copy from before the tag.
  async ambiguousServer() {
    const platform = await import('./platform.mjs');
    const la = await import('../../src/lib/local-account.js');
    const dbn = await import('../../src/lib/db-native.js');
    const athlete = { id: Number(process.env.LT_PHONE_USER) };
    const serverA = process.env.LT_SERVER, serverB = process.env.LT_SERVER_B, tokensB = JSON.parse(process.env.LT_TOKENS_B || '{}');
    const bUser = { id: Number(process.env.LT_B_USER) };
    me();
    await la.prepareLocalAccount(athlete, { confirm: async () => true });
    await web('phone', 'POST', '/api/programs', { name: 'A Private Plan' });
    await syncNow();
    offline(true);
    await api.saveWorkout('2026-09-01', { name: 'A Offline Session', exercises: [] });
    await api.createCardio({ date: '2026-09-01', activity: 'A Offline Row', duration_min: 10 });
    offline(false);
    const oldServer = (u) => String(u).startsWith(serverB) && /\/api\/auth\/status/.test(String(u));
    globalThis.__fetchHook = (u) => (oldServer(u)
      ? Promise.resolve(new Response(JSON.stringify({ active: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })) : null);
    process.env.LT_SERVER = serverB;
    platform.setAuthToken(tokensB.phone);
    localStorage.setItem('wl:userId', String(bUser.id));
    const early = await la.localDataIsThisAccount();
    let askedServer = null, askedDiscard = null;
    const ok = await la.prepareLocalAccount(bUser, {
      confirmServer: async (before, now) => { askedServer = [before === serverA.toLowerCase(), now === serverB.toLowerCase()]; return false; },
      confirm: async n => { askedDiscard = n; return true; },
    });
    await syncNow();
    globalThis.__fetchHook = null;
    const r = await realFetch(serverB + '/api/workout/2026-09-01/sessions', { headers: { Authorization: `Bearer ${tokensB.phone}` } });
    const different = {
      sameIds: bUser.id === athlete.id, early, ok, askedServer, askedDiscard,
      onB: ((await r.json()).sessions || []).map(s => s.name),
      phoneShowsA: names(await q(`SELECT name FROM programs WHERE name = 'A Private Plan'`)),
    };
    // A copy kept by an earlier version (no tag): tagged at startup as the
    // account last signed in here, so another account doesn't get it.
    process.env.LT_SERVER = serverA;
    platform.setAuthToken(tokens.phone);
    me();
    await dbn.dbClearUserData();
    await dbn.dbRun(`DELETE FROM sync_meta WHERE key = 'account'`, []);
    await la.prepareLocalAccount(athlete, { confirm: async () => true });
    await syncNow();
    offline(true);
    await api.createProgram({ name: 'Athlete Waiting' });
    offline(false);
    await dbn.dbRun(`DELETE FROM sync_meta WHERE key IN ('account', 'local_ids')`, []);
    const tagged = (await la.tagLegacyCopy?.()) ?? false;
    platform.setAuthToken(tokens.other);
    localStorage.setItem('wl:userId', process.env.LT_OTHER_USER);
    let askedCoach = null;
    const coachOk = await la.prepareLocalAccount({ id: Number(process.env.LT_OTHER_USER) }, { confirm: async n => { askedCoach = n; return false; } });
    return { different, legacy: { tagged, coachOk, askedCoach, kept: names(await q(`SELECT name FROM programs WHERE name = 'Athlete Waiting'`)) } };
  },

  // Signing out: a setting changed just before goes up under the account,
  // the session is gone, and signing in again shows the next account's own
  // values (kept on this device) without a reload.
  async signOutIn() {
    const platform = await import('./platform.mjs');
    const la = await import('../../src/lib/local-account.js');
    const { get } = await import('svelte/store');
    const st = await import('../../src/stores/settings.js');
    const auth = await import('../../src/stores/auth.js');
    const athlete = { id: Number(process.env.LT_PHONE_USER) }, coach = Number(process.env.LT_OTHER_USER);
    me();
    await la.prepareLocalAccount(athlete, { confirm: async () => true });
    await syncNow();
    localStorage.setItem(`wl_u${coach}_forceMobileLayout`, 'true');
    st.ntfyToken.set('athlete-ntfy-late');
    await auth.logout();
    const afterSignOut = { token: platform.getAuthToken(), ntfy: get(st.ntfyToken) };
    platform.setAuthToken(tokens.other);
    await auth.loadAuthState();
    return {
      afterSignOut,
      athleteServer: (await web('phone', 'GET', '/api/settings')).ntfyToken ?? null,
      coachLocal: get(st.forceMobileLayout),
    };
  },

  // Disconnect, then the same account again (another address of the same
  // server) while the server can't say which it is: asked. Same server:
  // the rows go back in place. Different: they go up as new.
  async unknownSameServer() { return reconnectUnknown(true); },
  async unknownDifferentServer() { return reconnectUnknown(false); },

  // The coach signed in on this phone (the server's cookie is in the
  // phone's jar), then the athlete signs in: the athlete's data only.
  async cookieSwitch() {
    const platform = await import('./platform.mjs');
    const la = await import('../../src/lib/local-account.js');
    const { CapacitorHttp } = await import('@capacitor/core');
    const coach = { id: Number(process.env.LT_OTHER_USER) }, athlete = { id: Number(process.env.LT_PHONE_USER) };
    await web('other', 'POST', '/api/programs', { name: 'Coach Private' });
    await web('phone', 'POST', '/api/programs', { name: 'Athlete Own' });
    // Another host's cookie (a sign-in gate in front of the server).
    const { CapacitorCookies } = await import('@capacitor/core');
    await CapacitorCookies.setCookie({ url: 'https://gate.example', key: 'gate_session', value: 'keep-me' });
    // And a gate's cookie on the server's own host (Cloudflare Access).
    await CapacitorCookies.setCookie({ url: server, key: 'CF_Authorization', value: 'keep-me-too' });
    // Signing in as the setup screen does: the server sets its cookie.
    const login = await CapacitorHttp.post({ url: server + '/api/auth/login', headers: { 'Content-Type': 'application/json' }, data: { username: 'coach', password: 'Str0ng-Pass-77!x' } });
    platform.setAuthToken(login.data.token);
    localStorage.setItem('wl:userId', String(coach.id));
    await la.prepareLocalAccount(coach, { confirm: async () => true });
    await syncNow();
    const coachSees = names(await q(`SELECT name FROM programs WHERE name IN ('Coach Private', 'Athlete Own') ORDER BY name`));
    // The athlete signs in on the same phone.
    platform.setAuthToken(tokens.phone);
    localStorage.setItem('wl:userId', String(athlete.id));
    await la.prepareLocalAccount(athlete, { confirm: async () => true });
    await syncNow(); await syncNow();
    return {
      coachSees, athleteSees: names(await q(`SELECT name FROM programs WHERE name IN ('Coach Private', 'Athlete Own') ORDER BY name`)),
      cookies: {
        server: await CapacitorCookies.getCookies({ url: server }),
        app: await CapacitorCookies.getCookies({ url: 'https://app.lifttrace.local' }),
        gate: await CapacitorCookies.getCookies({ url: 'https://gate.example' }),
      },
    };
  },

  // Edits made offline meet later (and earlier) edits on the web: the
  // newer edit of each field stays, on the server and on the phone.
  async newerWins() {
    me();
    const plan = await web('phone', 'POST', '/api/programs', { name: 'NW Plan', description: 'first' });
    const day = await web('phone', 'POST', '/api/templates', { program_id: plan.id, name: 'NW Day', exercises: [] });
    const ex = await web('phone', 'POST', '/api/exercises', { name: 'NW Curl' });
    const w = (await web('phone', 'PUT', '/api/workout/2026-09-01', { name: 'NW Session', notes: 'n0', exercises: [{ uuid: 'e1', name: 'Squat', sets: [{ uuid: 's1', reps: 5 }] }] })).workout;
    await web('phone', 'PUT', '/api/body-stats/2026-09-01', { stats: { weight: 80, waist: 90 } });
    await web('phone', 'PUT', '/api/settings', { key: 'weeklyWorkoutGoal', value: 3 });
    await syncNow();
    // Offline on the phone (earlier) ...
    offline(true);
    await api.updateProgram(plan.id, { name: 'Phone Rename', goal: 'strength' });
    await api.updateTemplate(day.id, { name: 'Phone Day', exercises: [] });
    await api.updateExercise(ex.id, { name: 'Phone Curl', category: 'arms' });
    await api.saveWorkout('2026-09-01', { id: w.id, name: 'Phone Session', notes: 'n0', exercises: [{ uuid: 'e1', name: 'Squat', sets: [{ uuid: 's1', reps: 5 }, { uuid: 's2', reps: 6 }] }] });
    await api.saveBodyStats('2026-09-01', { stats: { weight: 79, waist: 90 } });
    await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'weeklyWorkoutGoal', value: 4 }) });
    await later(1100);
    // ... then the web, later.
    await web('phone', 'PUT', `/api/programs/${plan.id}`, { name: 'Web Rename' });
    await web('phone', 'PUT', `/api/templates/${day.id}`, { name: 'Web Day' });
    await web('phone', 'PUT', `/api/exercises/${ex.id}`, { name: 'Web Curl' });
    await web('phone', 'PUT', '/api/workout/2026-09-01', { id: w.id, name: 'Web Session', notes: 'n0', exercises: [{ uuid: 'e1', name: 'Squat', sets: [{ uuid: 's1', reps: 5 }] }] });
    await web('phone', 'PUT', '/api/body-stats/2026-09-01', { stats: { weight: 81 } });
    await web('phone', 'PUT', '/api/settings', { key: 'weeklyWorkoutGoal', value: 5 });
    offline(false);
    await syncNow(); await syncNow();
    const sp = await web('phone', 'GET', `/api/programs/${plan.id}`);
    const sw = (await web('phone', 'GET', `/api/workout/2026-09-01?id=${w.id}`)).workout;
    const server = {
      program: `${sp.name} ${sp.goal}`, day: (await web('phone', 'GET', `/api/templates/${day.id}`)).name,
      exercise: (await web('phone', 'GET', '/api/exercises')).filter(e => e.id === ex.id).map(e => `${e.name} ${e.category}`)[0],
      workout: `${sw.name} sets:${sw.exercises[0].sets.length}`,
      body: (await web('phone', 'GET', '/api/body-stats/2026-09-01')).stats?.stats,
      goal: (await web('phone', 'GET', '/api/settings')).weeklyWorkoutGoal,
    };
    const pw = (await q(`SELECT name, exercises FROM workout_log WHERE id = ?`, [w.id]))[0];
    const phone = {
      program: (await q(`SELECT name, goal FROM programs WHERE id = ?`, [plan.id])).map(r => `${r.name} ${r.goal}`)[0],
      day: (await q(`SELECT name FROM workout_templates WHERE id = ?`, [day.id]))[0]?.name,
      exercise: (await q(`SELECT name, category FROM exercises WHERE id = ?`, [ex.id])).map(r => `${r.name} ${r.category}`)[0],
      workout: pw ? `${pw.name} sets:${JSON.parse(pw.exercises)[0].sets.length}` : null,
      body: JSON.parse((await q(`SELECT stats FROM body_stats_log WHERE date = '2026-09-01'`))[0]?.stats || 'null'),
      goal: JSON.parse((await q(`SELECT value FROM user_settings WHERE key = 'weeklyWorkoutGoal'`))[0]?.value ?? 'null'),
    };
    // The other way round: the web first, the phone's offline edit later.
    await web('phone', 'PUT', `/api/programs/${plan.id}`, { name: 'Web Earlier' });
    await syncNow();
    offline(true);
    await later(1100);
    await api.updateProgram(plan.id, { name: 'Phone Later' });
    offline(false);
    await syncNow(); await syncNow();
    return { server, phone, laterPhone: [(await web('phone', 'GET', `/api/programs/${plan.id}`)).name, (await q(`SELECT name FROM programs WHERE id = ?`, [plan.id]))[0]?.name] };
  },

  // A sync runs while a program workout for a phone-only program is half-way
  // into the queue (queued, applied here, its row not yet noted on it).
  async queueRace() {
    const platform = await import('./platform.mjs');
    const srv = process.env.LT_SERVER;
    process.env.LT_SERVER = '';
    platform.setAuthToken(null);
    await api.createProgram({ name: 'QR Plan' });
    process.env.LT_SERVER = srv;
    platform.setAuthToken(tokens.phone);
    me();
    await syncNow();
    const plan = (await q(`SELECT id FROM programs WHERE name = 'QR Plan'`))[0];
    let release, held = false;
    const gate = new Promise(r => { release = r; });
    globalThis.__dbBefore = async (sql, params) => {
      if (!held && /^UPDATE sync_queue SET payload = \? WHERE id = \?$/.test(sql) && String(params?.[0]).includes('"localId"')) { held = true; await gate; }
    };
    const making = api.createTemplate({ program_id: plan.id, name: 'QR Day', exercises: [] });
    await until(() => held, 'the write to be half-way');
    const syncing = sync.fullSync(true, true);
    await later(400);
    release();
    await making; await syncing;
    globalThis.__dbBefore = null;
    await syncNow(); await syncNow();
    const sp = (await web('phone', 'GET', '/api/programs')).find(p => p.name === 'QR Plan');
    return {
      server: sp ? (await web('phone', 'GET', `/api/programs/${sp.id}`)).templates.map(t => t.name) : [],
      phone: names(await q(`SELECT name FROM workout_templates WHERE name = 'QR Day'`)),
    };
  },

  // Made offline and then deleted, or renamed, offline: the delete and the
  // rename are newer than the create, wherever it arrives.
  async createThenEdit() {
    me();
    await syncNow();
    offline(true);
    const gone = await api.createProgram({ name: 'CT Gone' });
    const ex = await api.createExercise({ name: 'CT Gone Curl' });
    const s = (await api.saveWorkout('2026-09-05', { new_session: true, name: 'CT Gone Session', exercises: [] }));
    await later(1100);
    await api.deleteProgram(gone.id);
    await api.deleteExercise(ex.id);
    const sid = s?.workout?.id ?? s?.id;
    await fetch(`/api/workout/2026-09-05?id=${sid}`, { method: 'DELETE' });
    const kept = await api.createProgram({ name: 'CT Plan' });
    await later(1100);
    await api.updateProgram(kept.id, { name: 'CT Plan renamed' });
    offline(false);
    await syncRaw(); await syncNow();
    const { get } = await import('svelte/store');
    const sp = (await web('phone', 'GET', '/api/programs')).filter(p => p.name.startsWith('CT')).map(p => p.name).sort();
    return {
      server: { programs: sp, curls: (await web('phone', 'GET', '/api/exercises')).filter(e => e.name === 'CT Gone Curl').length,
        sessions: ((await web('phone', 'GET', '/api/workout/2026-09-05/sessions')).sessions || []).length },
      phone: names(await q(`SELECT name FROM programs WHERE name LIKE 'CT%' AND deleted_at IS NULL ORDER BY name`)),
      refused: (get(sync.syncState).refused || []).map(x => x.what),
    };
  },

  // A program and an old session under it, both deleted offline: deleting
  // the program touches the session on the server (its program link is
  // cleared), which is no edit, so the session's delete goes too.
  async deleteProgramThenSession() {
    me();
    const plan = await web('phone', 'POST', '/api/programs', { name: 'DP Plan' });
    await web('phone', 'PUT', '/api/workout/2026-08-20', { name: 'DP Session', program_id: plan.id, exercises: [] });
    await syncNow();
    const sid = (await q(`SELECT id FROM workout_log WHERE name = 'DP Session'`))[0].id;
    offline(true);
    await api.deleteProgram(plan.id);
    await fetch(`/api/workout/2026-08-20?id=${sid}`, { method: 'DELETE' });
    // Back online a while later: the program's delete then touches the
    // session (its program link cleared) after the session's delete was made.
    await later(2100);
    offline(false);
    await syncRaw(); await syncNow();
    const { get } = await import('svelte/store');
    return {
      server: { plan: (await web('phone', 'GET', '/api/programs')).filter(p => p.name === 'DP Plan').length,
        sessions: ((await web('phone', 'GET', '/api/workout/2026-08-20/sessions')).sessions || []).map(s => s.name) },
      phone: names(await q(`SELECT name FROM workout_log WHERE name = 'DP Session' AND deleted_at IS NULL`)),
      refused: (get(sync.syncState).refused || []).map(x => x.what),
    };
  },

  // A queued change whose last step never finishes: syncs still run and
  // finish, and never make its row a second time.
  async stuckQueueWrite() {
    const platform = await import('./platform.mjs');
    const srv = process.env.LT_SERVER;
    process.env.LT_SERVER = '';
    platform.setAuthToken(null);
    await api.createProgram({ name: 'SQ Plan' });
    process.env.LT_SERVER = srv;
    platform.setAuthToken(tokens.phone);
    me();
    await syncNow();
    const plan = (await q(`SELECT id FROM programs WHERE name = 'SQ Plan'`))[0];
    let release, held = false;
    const gate = new Promise(r => { release = r; });
    globalThis.__dbBefore = async (sql, params) => {
      if (!held && /^UPDATE sync_queue SET payload = \? WHERE id = \?$/.test(sql) && String(params?.[0]).includes('"localId"')) { held = true; await gate; }
    };
    api.createTemplate({ program_id: plan.id, name: 'SQ Day', exercises: [] }).catch(() => {});
    await until(() => held, 'the write to be half-way');
    const t0 = Date.now();
    const first = await sync.fullSync(true, true);
    const second = await sync.fullSync(true, true);
    const ms = Date.now() - t0;
    const whileStuck = (await web('phone', 'GET', `/api/programs`)).filter(p => p.name === 'SQ Plan').length;
    release();
    await later(300);
    globalThis.__dbBefore = null;
    await syncNow(); await syncNow();
    const sp = (await web('phone', 'GET', '/api/programs')).find(p => p.name === 'SQ Plan');
    return {
      finished: [first.ok !== undefined, second.ok !== undefined], quick: ms < 30000, whileStuck,
      days: sp ? (await web('phone', 'GET', `/api/programs/${sp.id}`)).templates.map(t => t.name) : [],
      phone: names(await q(`SELECT name FROM workout_templates WHERE name = 'SQ Day'`)),
    };
  },

  // A program deleted offline while one of its program workouts is edited
  // on the web later: the edit is newer, so the program and its workouts
  // stay. Edited first and deleted later, or never edited: the delete goes.
  async deleteProgramDayEdited() {
    me();
    const kept = await web('phone', 'POST', '/api/programs', { name: 'PD Plan' });
    const day = await web('phone', 'POST', '/api/templates', { program_id: kept.id, name: 'PD Day', exercises: [] });
    await web('phone', 'POST', '/api/templates', { program_id: kept.id, name: 'PD Other Day', exercises: [] });
    const earlier = await web('phone', 'POST', '/api/programs', { name: 'PE Plan' });
    const eday = await web('phone', 'POST', '/api/templates', { program_id: earlier.id, name: 'PE Day', exercises: [] });
    await web('phone', 'PUT', `/api/templates/${eday.id}`, { name: 'PE Day edited first' });
    const plain = await web('phone', 'POST', '/api/programs', { name: 'PN Plan' });
    await web('phone', 'POST', '/api/templates', { program_id: plain.id, name: 'PN Day', exercises: [] });
    await syncNow();
    await later(1100);
    offline(true);
    await api.deleteProgram(kept.id);
    await api.deleteProgram(earlier.id);
    await api.deleteProgram(plain.id);
    await later(1100);
    await web('phone', 'PUT', `/api/templates/${day.id}`, { name: 'PD Day edited later' });
    offline(false);
    await syncRaw(); await syncNow();
    const { get } = await import('svelte/store');
    const sp = (await web('phone', 'GET', '/api/programs')).filter(p => /^P[DEN] Plan/.test(p.name));
    const days = [];
    for (const p of sp) days.push(...(await web('phone', 'GET', `/api/programs/${p.id}`)).templates.map(t => t.name));
    return {
      server: { programs: sp.map(p => p.name).sort(), days: days.sort() },
      phone: {
        programs: names(await q(`SELECT name FROM programs WHERE name LIKE 'P_ Plan' AND deleted_at IS NULL ORDER BY name`)),
        days: names(await q(`SELECT name FROM workout_templates WHERE name LIKE 'P_ %' AND deleted_at IS NULL ORDER BY name`)),
      },
      refused: [...new Set((get(sync.syncState).refused || []).map(x => x.what))].sort(),
    };
  },

  // Deleted offline, edited on the web later: the edit is newer, so the
  // row stays and comes back to the phone. Edited on the web first, deleted
  // offline later: the delete goes.
  async deleteVsEdit() {
    me();
    const plan = await web('phone', 'POST', '/api/programs', { name: 'DV Plan' });
    const day = await web('phone', 'POST', '/api/templates', { program_id: plan.id, name: 'DV Day', exercises: [] });
    const ex = await web('phone', 'POST', '/api/exercises', { name: 'DV Curl' });
    const w = (await web('phone', 'PUT', '/api/workout/2026-09-03', { name: 'DV Session', exercises: [{ uuid: 'e1', name: 'Squat', sets: [{ uuid: 's1', reps: 5 }] }] })).workout;
    const gone = await web('phone', 'POST', '/api/programs', { name: 'DV Gone' });
    await syncNow();
    offline(true);
    await api.deleteProgram(plan.id);
    await api.deleteTemplate(day.id);
    await api.deleteExercise(ex.id);
    await fetch(`/api/workout/2026-09-03?id=${w.id}`, { method: 'DELETE' });
    const phoneWhileOffline = (await q(`SELECT COUNT(*) AS n FROM programs WHERE id = ? AND deleted_at IS NULL`, [plan.id]))[0].n;
    await later(1100);
    await web('phone', 'PUT', `/api/programs/${plan.id}`, { name: 'DV Plan edited later' });
    await web('phone', 'PUT', `/api/templates/${day.id}`, { name: 'DV Day edited later' });
    await web('phone', 'PUT', `/api/exercises/${ex.id}`, { name: 'DV Curl edited later' });
    await web('phone', 'PUT', '/api/workout/2026-09-03', { id: w.id, name: 'DV Session', exercises: [{ uuid: 'e1', name: 'Squat', sets: [{ uuid: 's1', reps: 5 }, { uuid: 's2', reps: 7 }] }] });
    offline(false);
    await syncRaw();
    await syncNow();
    // Every refusal the app reports, from whichever sync sent it.
    const { get } = await import('svelte/store');
    const reported = [...new Set((get(sync.syncState).refused || []).map(x => x.what))].sort();
    // The other way: edited on the web first, then deleted offline.
    await web('phone', 'PUT', `/api/programs/${gone.id}`, { name: 'DV Gone edited first' });
    await syncNow();
    offline(true);
    await later(1100);
    await api.deleteProgram(gone.id);
    offline(false);
    await syncNow(); await syncNow();
    const sp = await web('phone', 'GET', '/api/programs');
    const sw = ((await web('phone', 'GET', '/api/workout/2026-09-03/sessions')).sessions || []).map(s => `${s.name} sets:${s.exercises[0]?.sets?.length}`);
    return {
      phoneWhileOffline,
      refused: reported,
      server: {
        programs: sp.filter(p => p.name.startsWith('DV')).map(p => p.name).sort(),
        day: (await web('phone', 'GET', `/api/templates/${day.id}`).catch(() => null))?.name ?? null,
        exercise: (await web('phone', 'GET', '/api/exercises')).filter(e => e.id === ex.id).map(e => e.name)[0] ?? null,
        sessions: sw,
      },
      phone: {
        programs: names(await q(`SELECT name FROM programs WHERE name LIKE 'DV%' AND deleted_at IS NULL ORDER BY name`)),
        day: (await q(`SELECT name FROM workout_templates WHERE id = ? AND deleted_at IS NULL`, [day.id]))[0]?.name ?? null,
        exercise: (await q(`SELECT name FROM exercises WHERE id = ? AND deleted_at IS NULL`, [ex.id]))[0]?.name ?? null,
        sessions: (await q(`SELECT name, exercises FROM workout_log WHERE date = '2026-09-03' AND deleted_at IS NULL`)).map(s => `${s.name} sets:${JSON.parse(s.exercises)[0]?.sets?.length}`),
      },
    };
  },

  // Signing out with no connection: signed out at once, the sign-in screen
  // even on a relaunch with no connection, and the account's queued
  // changes wait for its own next sign-in.
  async logoutOffline() {
    const platform = await import('./platform.mjs');
    const la = await import('../../src/lib/local-account.js');
    const { get } = await import('svelte/store');
    const auth = await import('../../src/stores/auth.js');
    const athlete = { id: Number(process.env.LT_PHONE_USER) };
    me();
    await auth.loadAuthState();
    await la.prepareLocalAccount(athlete, { confirm: async () => true });
    await syncNow();
    offline(true);
    await api.createProgram({ name: 'Queued Before Sign Out' });
    const t0 = Date.now();
    await auth.logout();
    const ms = Date.now() - t0;
    const queue = (await q(`SELECT payload FROM sync_queue`)).map(r => JSON.parse(r.payload).path);
    const right = { token: platform.getAuthToken(), user: get(auth.currentUser), quick: ms < 3000 };
    // Opened again with no connection.
    await auth.loadAuthState();
    const relaunch = { mgmt: get(auth.userMgmtActive), user: get(auth.currentUser) };
    // The connection comes back: nothing goes up for a signed-out account.
    offline(false);
    const sync1 = await syncRaw();
    const serverWhileOut = (await web('phone', 'GET', '/api/programs')).filter(p => p.name === 'Queued Before Sign Out').length;
    // The athlete signs in again: it goes up then.
    platform.setAuthToken(tokens.phone);
    me();
    await la.prepareLocalAccount(athlete, { confirm: async () => true });
    await syncNow();
    return {
      queue, right, relaunch, sync1: sync1.reason ?? null, serverWhileOut,
      afterSignIn: (await web('phone', 'GET', '/api/programs')).filter(p => p.name === 'Queued Before Sign Out').length,
    };
  },

  // A program workout added to a phone-only program while a sync is
  // creating that program on the server: made once.
  async createDuringFlush() {
    const platform = await import('./platform.mjs');
    const srv = process.env.LT_SERVER;
    process.env.LT_SERVER = '';
    platform.setAuthToken(null);
    await api.createProgram({ name: 'Race Plan' });
    process.env.LT_SERVER = srv;
    platform.setAuthToken(tokens.phone);
    me();
    await syncNow();
    const plan = (await q(`SELECT id FROM programs WHERE name = 'Race Plan'`))[0];
    let release, entered = false;
    const held = new Promise(r => { release = r; });
    globalThis.__httpHook = async (method, o) => {
      if (method === 'POST' && /\/api\/programs$/.test(o.url) && !entered) { entered = true; await held; }
      return null;
    };
    await api.updateProgram(plan.id, { name: 'Race Plan renamed' });
    const first = sync.fullSync(true, true);
    await until(() => entered, 'the program to be on its way up');
    await api.createTemplate({ program_id: plan.id, name: 'Race Day', exercises: [] });
    release();
    await first;
    globalThis.__httpHook = null;
    await syncNow(); await syncNow();
    const sp = (await web('phone', 'GET', '/api/programs')).filter(p => p.name.startsWith('Race Plan'));
    return {
      plans: sp.map(p => p.name),
      days: sp[0] ? (await web('phone', 'GET', `/api/programs/${sp[0].id}`)).templates.map(t => t.name) : [],
      phoneDays: names(await q(`SELECT name FROM workout_templates WHERE name = 'Race Day'`)),
    };
  },
};

async function reconnectUnknown(answer) {
  const platform = await import('./platform.mjs');
  const la = await import('../../src/lib/local-account.js');
  const athlete = { id: Number(process.env.LT_PHONE_USER) };
  const plan = await web('phone', 'POST', '/api/programs', { name: 'Q Plan' });
  await web('phone', 'POST', '/api/templates', { program_id: plan.id, name: 'Q Day', exercises: [] });
  await web('phone', 'PUT', '/api/workout/2026-08-01', { name: 'Q Session', exercises: [] });
  me();
  await la.prepareLocalAccount(athlete, { confirm: async () => true });
  await syncNow();
  await la.settleQueuedChanges('disconnect', { ask: async () => true });
  await la.setLocalOwner();
  // Back at another address of the same server, which (an older build, or
  // its status not answering) reports no instance id.
  const other = process.env.LT_SERVER.replace('127.0.0.1', 'localhost');
  globalThis.__fetchHook = (u) => (String(u).startsWith(other) && /\/api\/auth\/status/.test(String(u))
    ? Promise.resolve(new Response(JSON.stringify({ active: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })) : null);
  process.env.LT_SERVER = other;
  platform.setAuthToken(tokens.phone);
  me();
  const asked = [];
  const confirmServer = async (before, now) => { asked.push([before.includes('127.0.0.1'), now.includes('localhost')]); return answer; };
  const { countLocalData, uploadLocalToServer } = await import('../../src/lib/migrate.js');
  const counts = await countLocalData({ confirmServer });
  const sum = await uploadLocalToServer({ confirmServer });
  await la.claimForServer(other, athlete.id, { clear: false, confirmServer });
  await syncNow(); await syncNow();
  globalThis.__fetchHook = null;
  const sessions = ((await web('phone', 'GET', '/api/workout/2026-08-01/sessions')).sessions || []).map(s => s.name);
  return {
    asked, counts: { w: counts.workouts, p: counts.programs }, uploaded: { w: sum.success.workouts, p: sum.success.programs },
    server: { sessions, plans: (await web('phone', 'GET', '/api/programs')).filter(p => p.name === 'Q Plan').length },
    phone: { sessions: names(await q(`SELECT name FROM workout_log ORDER BY name`)), plans: (await q(`SELECT COUNT(*) AS n FROM programs WHERE name = 'Q Plan'`))[0].n },
  };
}

const name = process.argv[2];
const out = await scenarios[name]();
console.log(JSON.stringify(out));
process.exit(0);
