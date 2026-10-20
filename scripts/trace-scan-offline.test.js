/**
 * Trace's long workout lists through the web app's real offline layer
 * (TraceApps/notetrace#34).
 *
 * With no connection, the offline layer answers a list it never kept (the
 * 2,000 Trace asks for to reach years back) with any copy of the list it
 * has: the usual 200, or the Diary's 3. Read as the server's answer, a list
 * shorter than asked for looked like every workout there is, and Trace
 * would have said so. These load lib/offline-api.js against a small
 * stand-in for IndexedDB (as offline-storage-save.test.js does) and send
 * the real tools' requests through it.
 */
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

mock.timers.enable({ apis: ['setTimeout'] });
globalThis.BroadcastChannel = undefined;
Object.defineProperty(globalThis, 'localStorage', { value: undefined, configurable: true, writable: true });
const setOnline = (on) => Object.defineProperty(globalThis, 'navigator', { value: { onLine: on }, configurable: true, writable: true });
setOnline(true);

class FakeRequest { constructor() { this.result = undefined; this.error = null; this.onsuccess = null; this.onerror = null; } }
globalThis.IDBRequest = FakeRequest;
const later = (fn) => queueMicrotask(fn);
const clone = (v) => (v === undefined ? undefined : structuredClone(v));

/** Just enough IndexedDB for lib/offline-api.js. */
function fakeIndexedDB() {
  const dbs = new Map();
  class Tx {
    constructor(db) { this.db = db; this.pending = 0; this.finished = false; this.oncomplete = this.onerror = this.onabort = null; later(() => this.check()); }
    objectStore(name) { return new Store(this.db.stores.get(name), this); }
    done() { this.pending--; this.check(); }
    check() { if (this.pending > 0 || this.finished) return; this.finished = true; later(() => this.oncomplete?.()); }
  }
  class Store {
    constructor(def, tx) { this.def = def; this.tx = tx; }
    req(fn) {
      const req = new FakeRequest();
      this.tx.pending++;
      later(() => { req.result = fn(); req.onsuccess?.({ target: req }); this.tx.done(); });
      return req;
    }
    getAll() { return this.req(() => [...this.def.rows.values()].map(clone)); }
    get(key) { return this.req(() => clone(this.def.rows.get(key))); }
    add(value) {
      return this.req(() => {
        let key = this.def.keyPath ? value[this.def.keyPath] : undefined;
        if (key == null && this.def.autoIncrement) { key = ++this.def.seq; value = { ...value, [this.def.keyPath]: key }; }
        this.def.rows.set(key, clone(value));
        return key;
      });
    }
    put(value, outOfLine) { return this.req(() => { const key = outOfLine ?? value[this.def.keyPath]; this.def.rows.set(key, clone(value)); return key; }); }
    delete(key) { return this.req(() => { this.def.rows.delete(key); }); }
    clear() { return this.req(() => { this.def.rows.clear(); }); }
  }
  class DB {
    constructor() { this.version = 0; this.stores = new Map(); }
    get objectStoreNames() { return { contains: (n) => this.stores.has(n) }; }
    createObjectStore(name, opts = {}) { this.stores.set(name, { keyPath: opts.keyPath, autoIncrement: !!opts.autoIncrement, rows: new Map(), seq: 0 }); }
    transaction() { return new Tx(this); }
    close() {}
  }
  const idb = {
    open(name, version) {
      const req = new FakeRequest();
      later(() => {
        let db = dbs.get(name);
        if (!db) { db = new DB(); dbs.set(name, db); }
        req.result = db;
        if (version && version > db.version) { db.version = version; req.onupgradeneeded?.(); }
        req.onsuccess?.();
      });
      return req;
    },
    deleteDatabase(name) { dbs.delete(name); },
  };
  const kept = () => [...dbs.values()].flatMap((db) => [...(db.stores.get('answers')?.rows.keys() || [])]);
  return { idb, kept };
}

const day = (offset = 0) => { const d = new Date(); d.setDate(d.getDate() + offset); return d.toLocaleDateString('sv-SE'); };
const workout = (id, date) => ({ id, date, session_seq: 0, completed: true, exercises: [{ exercise_id: 1, exercise_name: 'Bench Press', sets: [{ weight: 100, reps: 5, completed: true }] }] });
// Four years of three workouts a week.
const years = Array.from({ length: 624 }, (_, i) => workout(i + 1, day(-Math.floor(i * 7 / 3) - 1)));

let loads = 0;
/** A fresh page: the offline layer, the server behind it, and the tools sending through it. */
async function page() {
  const { idb, kept } = fakeIndexedDB();
  globalThis.indexedDB = idb;
  const offline = await import(`../src/lib/offline-api.js?page=${++loads}`);
  const server = { up: true, asked: [], upTo: Infinity };
  const serverFetch = async (url) => {
    server.asked.push(String(url));
    const limit = Number(new URL(String(url), 'http://x').searchParams.get('limit')) || 0;
    if (!server.up || limit > server.upTo) throw new TypeError('Failed to fetch');
    const u = new URL(String(url), 'http://x');
    const body = u.pathname === '/api/workout/recent' ? years.slice(0, Number(u.searchParams.get('limit')) || 30) : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  globalThis.fetch = (url, init) => offline.offlineFetch(url, init, serverFetch);
  const tools = await import(`../src/lib/aiTools.js?page=${loads}`);
  const goOffline = () => { server.up = false; setOnline(false); };
  return { offline, server, tools, kept, goOffline };
}

test('online, a range years back is read in full, and the long list is not kept on the device', async () => {
  const { tools, kept } = await page();
  const from = day(-3 * 365);
  const r = await tools.runTool('get_workouts', { date_from: from, date_to: day(0) });
  assert.equal(r.count, years.filter((w) => w.date >= from).length);
  assert.equal(r.note, undefined);
  assert.ok(kept().includes('/api/workout/recent?limit=200'), 'the usual list is kept');
  assert.ok(!kept().some((k) => /limit=(2000|20000)/.test(k)), `long lists are not kept: ${kept().join(', ')}`);
});

test('offline, a range past what was kept says what is missing instead of claiming it all', async () => {
  const { tools, goOffline } = await page();
  await tools.runTool('get_workouts', { date_from: day(-14), date_to: day(0) }); // keeps the 200
  tools.forgetToolReads();
  goOffline();
  const r = await tools.runTool('get_workouts', { date_from: day(-3 * 365), date_to: day(0) });
  assert.equal(r.count, 200, 'the 200 kept');
  assert.match(r.note || '', /earlier ones in this range are missing/, JSON.stringify(r).slice(0, 300));
  // A range the kept list covers says nothing.
  assert.ok(Array.isArray(await tools.runTool('get_workouts', { date_from: day(-30), date_to: day(0) })));
  setOnline(true);
});

test('offline with only the Diary\'s three kept, Trace says it could read only those', async () => {
  const { tools, goOffline } = await page();
  await fetch('/api/workout/recent?limit=3'); // the Diary's read
  goOffline();
  const r = await tools.runTool('get_workouts', { date_from: day(-365), date_to: day(0) });
  assert.equal(r.count, 3);
  assert.match(r.note || '', new RegExp(`from ${years[2].date} on`));
  setOnline(true);
});

test('a connection lost between the usual list and a longer one keeps the longer list read', async () => {
  const { tools, server } = await page();
  await fetch('/api/workout/recent?limit=3'); // the Diary's read, kept first
  server.upTo = 200; // the 200 comes back, then the connection drops
  const r = await tools.runTool('get_workouts', { date_from: day(-3 * 365), date_to: day(0) });
  assert.equal(r.count, 200, 'the 200 read, not the 3 kept for the Diary');
  assert.match(r.note || '', new RegExp(`from ${years[199].date} on`));
});

test('a workout saved offline, on the end of the kept list, does not hide that the range is covered', async () => {
  const { tools, goOffline } = await page();
  await tools.runTool('get_workouts', { date_from: day(-14), date_to: day(0) });
  tools.forgetToolReads();
  goOffline();
  // Logged today with no connection: the offline layer adds it to the list.
  const saved = await fetch(`/api/workout/${day(0)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ exercises: workout(0, day(0)).exercises }) });
  assert.ok(saved.ok, 'queued');
  const r = await tools.runTool('get_workouts', { date_from: day(-30), date_to: day(0) });
  assert.ok(Array.isArray(r), `covered, no note: ${JSON.stringify(r).slice(0, 200)}`);
  assert.ok(r.some((w) => w.date === day(0)), 'the workout logged offline is in it');
  setOnline(true);
});

test('paging one answer asks the server for the list once', async () => {
  const { tools, server } = await page();
  const from = day(-3 * 365);
  let r = await tools.runTool('get_workouts', { date_from: from, date_to: day(0) });
  const asked = server.asked.length;
  while (!r.complete) r = await tools.runTool('get_workouts', { date_from: from, date_to: day(0), offset: r.next_offset, limit: 50 });
  assert.equal(server.asked.length, asked, 'the later pages come from the list already read');
  // A write in between reads afresh.
  await tools.runTool('log_body_stat', { date: day(0), stat: 'weight', value: 80 }).catch(() => {});
  await tools.runTool('get_workouts', { date_from: from, date_to: day(0) });
  assert.ok(server.asked.length > asked);
});
