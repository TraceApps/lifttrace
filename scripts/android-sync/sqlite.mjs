// @capacitor-community/sqlite on better-sqlite3 (the server's driver), one
// in-memory database per connection name.
import { createRequire } from 'node:module';

const Database = createRequire(new URL('../../server/package.json', import.meta.url))('better-sqlite3');
const dbs = new Map();
const norm = p => (p || []).map(v => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
// Scenarios can count calls and statements (__dbStats), slow every call down
// by up to N ms (__dbJitter: races), or stop a call part way (__dbKill(sql,
// n): true kills the n-th statement of a call, as an app killed then would).
const stats = () => (globalThis.__dbStats ||= { calls: 0, statements: 0 });
const jit = async () => {
  stats().calls++;
  const j = Number(globalThis.__dbJitter) || 0;
  if (j > 0) await new Promise(r => setTimeout(r, Math.random() * j));
};
const kill = (sql, n) => { if (globalThis.__dbKill?.(sql, n)) throw new Error('killed'); };

function conn(name) {
  if (!dbs.has(name)) dbs.set(name, new Database(':memory:'));
  const db = dbs.get(name);
  return {
    async open() {}, async close() {},
    // As the Android plugin runs a script (UtilsSQLite.getStatementsArray +
    // Database.execute): split on ";\n" only, lines joined, "--" comments
    // dropped, and each piece handed to execSQL, which runs only its first
    // statement. Two statements on one line: the second never runs there,
    // so it doesn't here either.
    async execute(sql) {
      await jit();
      const before = db.prepare('SELECT total_changes() AS n').get().n;
      for (const raw of String(sql).replace(/end;/g, 'END;').split(';\n')) {
        const piece = raw.split('\n').map(l => { const i = l.indexOf('--'); return (i > -1 ? l.slice(0, i) : l).trim(); }).filter(Boolean).join(' ');
        if (!piece) continue;
        const first = piece.includes(';') ? piece.slice(0, piece.indexOf(';')) : piece;
        if (first.trim()) { stats().statements++; db.exec(first); }
      }
      return { changes: { changes: db.prepare('SELECT total_changes() AS n').get().n - before } };
    },
    // One transaction: every statement or none (the plugin's executeSet).
    async executeSet(set, transaction = true) {
      await jit();
      const runAll = () => set.forEach(({ statement, values }, i) => {
        stats().statements++;
        kill(statement, i + 1);
        db.prepare(statement).run(...norm(values));
      });
      if (transaction) db.transaction(runAll)(); else runAll();
      return { changes: { changes: set.length } };
    },
    async query(sql, params) {
      await jit();
      stats().statements++;
      const st = db.prepare(sql);
      if (!st.reader) { st.run(...norm(params)); return { values: [] }; }
      return { values: st.all(...norm(params)) };
    },
    async run(sql, params) {
      await jit();
      if (globalThis.__dbBefore) await globalThis.__dbBefore(sql, params);
      stats().statements++;
      kill(sql, 1);
      const r = db.prepare(sql).run(...norm(params));
      return { changes: { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) } };
    },
  };
}

export const CapacitorSQLite = {};
export class SQLiteConnection {
  async checkConnectionsConsistency() { return { result: false }; }
  async isConnection() { return { result: false }; }
  async closeConnection() {}
  async closeAllConnections() {}
  async retrieveConnection(n) { return conn(n); }
  async createConnection(n) { return conn(n); }
}
