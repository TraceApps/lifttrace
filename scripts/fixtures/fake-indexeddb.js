/**
 * Just enough IndexedDB for lib/offline-api.js, with switches to break it,
 * for tests that load the real offline layer in Node.
 */
export class FakeRequest {
  constructor() { this.result = undefined; this.error = null; this.onsuccess = null; this.onerror = null; }
}

const later = (fn) => queueMicrotask(fn);
const clone = (v) => (v === undefined ? undefined : structuredClone(v));

export function fakeIndexedDB() {
  const env = { dbs: new Map(), openThrows: false, broken: false, full: false };
  class Tx {
    constructor(db) {
      this.db = db; this.pending = 0; this.failed = null; this.finished = false;
      this.oncomplete = this.onerror = this.onabort = null;
      later(() => this.check());
    }
    objectStore(name) {
      const def = this.db.stores.get(name);
      if (!def) throw new DOMException(`No store ${name}`, 'NotFoundError');
      return new Store(def, this);
    }
    done() { this.pending--; this.check(); }
    check() {
      if (this.pending > 0 || this.finished) return;
      this.finished = true;
      later(() => {
        if (this.failed) { this.error = this.failed; this.onerror?.(); this.onabort?.(); } else this.oncomplete?.();
      });
    }
  }
  class Store {
    constructor(def, tx) { this.def = def; this.tx = tx; }
    req(fn, write) {
      const req = new FakeRequest();
      this.tx.pending++;
      later(() => {
        try {
          if (write && env.full) throw new DOMException('Quota exceeded', 'QuotaExceededError');
          req.result = fn();
          req.onsuccess?.({ target: req });
        } catch (e) {
          req.error = e; this.tx.failed = e; req.onerror?.({ target: req });
        }
        this.tx.done();
      });
      return req;
    }
    getAll() { return this.req(() => [...this.def.rows.values()].map(clone)); }
    get(key) { return this.req(() => clone(this.def.rows.get(key))); }
    add(value) {
      return this.req(() => {
        let key = this.def.keyPath ? value[this.def.keyPath] : undefined;
        if (key == null && this.def.autoIncrement) { key = ++this.def.seq; value = { ...value, [this.def.keyPath]: key }; }
        if (this.def.rows.has(key)) throw new DOMException('Key exists', 'ConstraintError');
        this.def.rows.set(key, clone(value));
        return key;
      }, true);
    }
    put(value, outOfLine) {
      return this.req(() => {
        const key = outOfLine ?? value[this.def.keyPath];
        this.def.rows.set(key, clone(value));
        return key;
      }, true);
    }
    delete(key) { return this.req(() => { this.def.rows.delete(key); }, true); }
    clear() { return this.req(() => { this.def.rows.clear(); }, true); }
  }
  class DB {
    constructor(name) { this.name = name; this.version = 0; this.stores = new Map(); }
    get objectStoreNames() { return { contains: (n) => this.stores.has(n) }; }
    createObjectStore(name, opts = {}) {
      this.stores.set(name, { keyPath: opts.keyPath, autoIncrement: !!opts.autoIncrement, rows: new Map(), seq: 0 });
    }
    transaction() {
      // What a dropped connection does: every new transaction throws.
      if (env.broken) throw new DOMException('The database connection is closing.', 'InvalidStateError');
      return new Tx(this);
    }
    close() {}
  }
  const idb = {
    open(name, version) {
      // What a browser refusing this site storage does.
      if (env.openThrows) throw new DOMException('The operation is insecure.', 'SecurityError');
      const req = new FakeRequest();
      later(() => {
        let db = env.dbs.get(name);
        if (!db) { db = new DB(name); env.dbs.set(name, db); }
        req.result = db;
        if (version && version > db.version) { db.version = version; req.onupgradeneeded?.(); }
        req.onsuccess?.();
      });
      return req;
    },
    deleteDatabase(name) { env.dbs.delete(name); },
  };
  /** A change already waiting when the page opens. */
  env.seed = (op) => {
    const name = 'lifttrace-offline-single';
    let db = env.dbs.get(name);
    if (!db) { db = new DB(name); env.dbs.set(name, db); db.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true }); }
    const out = db.stores.get('outbox');
    const seq = ++out.seq;
    out.rows.set(seq, { ...op, seq });
  };
  env.outbox = () => [...(env.dbs.get('lifttrace-offline-single')?.stores.get('outbox')?.rows.values() || [])];
  return { idb, env };
}

globalThis.IDBRequest = FakeRequest;
