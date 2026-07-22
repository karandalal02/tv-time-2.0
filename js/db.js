// Tiny IndexedDB wrapper. All watch data lives locally on the device — no
// server, no account, fully private. Stores:
//   shows    -> { id, name, poster, backdrop, firstAirDate, status,
//                 overview, seasons: [{season_number, name, episodes:[...]}],
//                 addedAt, listType: 'watching' | 'watchlist' }
//   watched  -> { key: 'showId:season:episode', showId, season, episode, at }
//   ratings  -> { showId, rating, at }
//   settings -> { k, v }

const DB_NAME = 'tally';
const DB_VERSION = 1;
let _db = null;

function open() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('shows')) db.createObjectStore('shows', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('watched')) {
        const s = db.createObjectStore('watched', { keyPath: 'key' });
        s.createIndex('byShow', 'showId', { unique: false });
      }
      if (!db.objectStoreNames.contains('ratings')) db.createObjectStore('ratings', { keyPath: 'showId' });
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'k' });
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode) {
  return open().then((db) => db.transaction(store, mode).objectStore(store));
}
function done(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export const db = {
  async getAll(store) { return done((await tx(store, 'readonly')).getAll()); },
  async get(store, key) { return done((await tx(store, 'readonly')).get(key)); },
  async put(store, value) { return done((await tx(store, 'readwrite')).put(value)); },
  async del(store, key) { return done((await tx(store, 'readwrite')).delete(key)); },

  async getWatchedForShow(showId) {
    const store = await tx('watched', 'readonly');
    return done(store.index('byShow').getAll(showId));
  },
  async delWhere(store, predicate) {
    const s = await tx(store, 'readwrite');
    const all = await done(s.getAll());
    await Promise.all(all.filter(predicate).map((r) => done(s.delete(r[s.keyPath]))));
  },

  // Settings helpers
  async getSetting(k, fallback = null) {
    const r = await this.get('settings', k);
    return r ? r.v : fallback;
  },
  async setSetting(k, v) { return this.put('settings', { k, v }); },

  // Full export / import for backup.
  async exportAll() {
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      shows: await this.getAll('shows'),
      watched: await this.getAll('watched'),
      ratings: await this.getAll('ratings')
    };
  },
  async importAll(data) {
    for (const s of data.shows || []) await this.put('shows', s);
    for (const w of data.watched || []) await this.put('watched', w);
    for (const r of data.ratings || []) await this.put('ratings', r);
  }
};
