/**
 * db.js - IndexedDB abstraction layer for LiftTrace
 */
const DB = (() => {
  const DB_NAME = 'lifttrace';
  const DB_VERSION = 1;
  let _db = null;
  let _initPromise = null;

  const STORES = {
    workoutLog: {
      keyPath: 'id',
      autoIncrement: true,
      indexes: [
        { name: 'date', keyPath: 'date', unique: false },
        { name: 'dateTime', keyPath: 'dateTime', unique: false },
      ]
    },
    bodyStats: {
      keyPath: 'id',
      autoIncrement: true,
      indexes: [
        { name: 'date', keyPath: 'date', unique: false },
      ]
    },
  };

  function _open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        const txn = event.target.transaction;
        for (const [storeName, config] of Object.entries(STORES)) {
          if (!db.objectStoreNames.contains(storeName)) {
            const store = db.createObjectStore(storeName, {
              keyPath: config.keyPath,
              autoIncrement: config.autoIncrement
            });
            for (const idx of config.indexes) {
              store.createIndex(idx.name, idx.keyPath, { unique: idx.unique });
            }
          } else {
            const store = txn.objectStore(storeName);
            for (const idx of config.indexes) {
              if (!store.indexNames.contains(idx.name)) {
                store.createIndex(idx.name, idx.keyPath, { unique: idx.unique });
              }
            }
          }
        }
      };
      request.onsuccess = (event) => { _db = event.target.result; resolve(_db); };
      request.onerror = (event) => reject(event.target.error);
    });
  }

  function _getStore(storeName, mode) {
    return _db.transaction(storeName, mode || 'readonly').objectStore(storeName);
  }

  function _p(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  return {
    async init() {
      if (_db) return _db;
      if (!_initPromise) _initPromise = _open();
      return _initPromise;
    },
    add(store, item) {
      item.dateTime = item.dateTime || new Date().toISOString();
      return _p(_getStore(store, 'readwrite').add(item));
    },
    put(store, item) {
      return _p(_getStore(store, 'readwrite').put(item));
    },
    get(store, id) {
      return _p(_getStore(store).get(id));
    },
    getAll(store) {
      return _p(_getStore(store).getAll());
    },
    getByIndex(store, indexName, value) {
      return _p(_getStore(store).index(indexName).getAll(value));
    },
    delete(store, id) {
      return _p(_getStore(store, 'readwrite').delete(id));
    },
    clear(store) {
      return _p(_getStore(store, 'readwrite').clear());
    },
    _settingKey(key) {
      const userId = localStorage.getItem('wl:userId');
      return userId ? `wl_u${userId}_${key}` : `wl_${key}`;
    },
    getSetting(key, def) {
      const raw = localStorage.getItem(this._settingKey(key));
      if (raw === null) return (def !== undefined ? def : null);
      try { return JSON.parse(raw); } catch(e) { return raw; }
    },
    setSetting(key, value) {
      localStorage.setItem(this._settingKey(key), JSON.stringify(value));
      window.dispatchEvent(new CustomEvent('wl:setting', { detail: { key } }));
    },
    getAllSettings() {
      const prefix = this._settingKey('').replace(/[^_]*$/, '');
      const s = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(prefix)) {
          const bare = k.slice(prefix.length);
          try { s[bare] = JSON.parse(localStorage.getItem(k)); }
          catch(e) { s[bare] = localStorage.getItem(k); }
        }
      }
      return s;
    },
    removeSetting(key) {
      localStorage.removeItem(this._settingKey(key));
    },
    /** Move every setting from one user-prefix to another. Used by the
     *  enable/disable user-management flows so wizard-configured settings
     *  follow the user across the prefix change instead of getting orphaned.
     *  Pass `null` for the anonymous prefix (`wl_<key>`). Existing target
     *  keys are NOT overwritten — the new owner's choices win on collision. */
    migrateSettingsPrefix(fromUserId, toUserId) {
      const fromPrefix = fromUserId == null ? 'wl_' : `wl_u${fromUserId}_`;
      const toPrefix   = toUserId   == null ? 'wl_' : `wl_u${toUserId}_`;
      if (fromPrefix === toPrefix) return 0;
      let moved = 0;
      const orphans = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith(fromPrefix)) continue;
        // Exclude longer-prefixed keys like `wl_u12_*` from the bare `wl_` scan.
        if (fromPrefix === 'wl_' && /^wl_u\d+_/.test(k)) continue;
        orphans.push(k);
      }
      for (const fromKey of orphans) {
        const bare = fromKey.slice(fromPrefix.length);
        const toKey = toPrefix + bare;
        if (localStorage.getItem(toKey) === null) {
          localStorage.setItem(toKey, localStorage.getItem(fromKey));
          moved++;
        }
        localStorage.removeItem(fromKey);
      }
      return moved;
    },
    async clearAll() {
      await Promise.all([
        this.clear('workoutLog'),
        this.clear('bodyStats'),
      ]);
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('wl_')) keys.push(k);
      }
      keys.forEach(k => localStorage.removeItem(k));
    }
  };
})();

export { DB };

export function localDateStr(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
