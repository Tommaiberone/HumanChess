// Games and reviews kept in the browser (IndexedDB), so nothing is analysed twice and
// nothing leaves the device. Falls back to memory where IndexedDB is unavailable
// (some private windows): the app then works, but forgets on reload.

const DB = 'smartchess';
const STORES = ['games', 'reviews'];

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => STORES.forEach(s => request.result.createObjectStore(s));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

const wrap = request => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

export class Storage {
  constructor() {
    this.memory = Object.fromEntries(STORES.map(s => [s, new Map()]));
    this.db = (async () => {
      try {
        return await openDb();
      } catch {
        return null;
      }
    })();
  }

  async _store(name, mode) {
    const db = await this.db;
    return db ? db.transaction(name, mode).objectStore(name) : null;
  }

  async get(name, key) {
    try {
      const store = await this._store(name, 'readonly');
      if (store) return (await wrap(store.get(key))) ?? null;
    } catch { /* fall back to memory */ }
    return this.memory[name].get(key) ?? null;
  }

  async put(name, key, value) {
    this.memory[name].set(key, value);
    try {
      const store = await this._store(name, 'readwrite');
      if (store) await wrap(store.put(value, key));
    } catch { /* the in-memory copy still serves this session */ }
  }

  async all(name) {
    try {
      const store = await this._store(name, 'readonly');
      if (store) return await wrap(store.getAll());
    } catch { /* fall back to memory */ }
    return [...this.memory[name].values()];
  }
}

export const reviewKey = (id, color) => `${id}:${color}`;
