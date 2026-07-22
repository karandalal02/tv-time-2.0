// Tiny IndexedDB wrapper. All watch data lives locally on the device and can
// additionally sync to the user's own Google Drive (see sync.js). Stores:
//   shows    -> TV shows and movies (composite ids like 'tv:1399')
//   watched  -> { key: 'showId:season:episode', showId, season, episode, at }
//   ratings  -> { showId, rating, at }
//   settings -> { k, v }

const DB_NAME = 'tally'; // kept from v1 so existing data survives upgrades
const DB_VERSION = 1;
const DATA_STORES = ['shows', 'watched', 'ratings']; // stores that count as "user data" for sync
let _db = null;
let _onChange = null;      // called after any user-data write (sync scheduling)
let _suppress = false;     // true while sync applies remote data (avoid loops)

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

// After any user-data mutation: bump the local change clock and notify sync.
async function noteChange(store) {
  if (_suppress || !DATA_STORES.includes(store)) return;
  const s = await tx('settings', 'readwrite');
  await done(s.put({ k: 'lastChangeAt', v: Date.now() }));
  if (_onChange) _onChange();
}

export const db = {
  async getAll(store) { return done((await tx(store, 'readonly')).getAll()); },
  async get(store, key) { return done((await tx(store, 'readonly')).get(key)); },
  async put(store, value) {
    const r = await done((await tx(store, 'readwrite')).put(value));
    await noteChange(store);
    return r;
  },
  async del(store, key) {
    const r = await done((await tx(store, 'readwrite')).delete(key));
    await noteChange(store);
    return r;
  },
  async clearStore(store) { return done((await tx(store, 'readwrite')).clear()); },

  async getWatchedForShow(showId) {
    const store = await tx('watched', 'readonly');
    return done(store.index('byShow').getAll(showId));
  },
  async delWhere(store, predicate) {
    const s = await tx(store, 'readwrite');
    const all = await done(s.getAll());
    await Promise.all(all.filter(predicate).map((r) => done(s.delete(r[s.keyPath]))));
    await noteChange(store);
  },

  // Settings helpers
  async getSetting(k, fallback = null) {
    const r = await this.get('settings', k);
    return r ? r.v : fallback;
  },
  async setSetting(k, v) { return this.put('settings', { k, v }); },

  // Sync hooks
  onDataChange(fn) { _onChange = fn; },
  setSuppressChanges(on) { _suppress = on; },

  // Full export / import for backup and Drive sync. Includes the TMDB key so a
  // restored device works immediately.
  async exportAll() {
    return {
      version: 2,
      exportedAt: new Date().toISOString(),
      shows: await this.getAll('shows'),
      watched: await this.getAll('watched'),
      ratings: await this.getAll('ratings'),
      settings: { tmdbKey: await this.getSetting('tmdbKey', '') }
    };
  },
  async importAll(data) {
    for (const s of data.shows || []) await this.put('shows', s);
    for (const w of data.watched || []) await this.put('watched', w);
    for (const r of data.ratings || []) await this.put('ratings', r);
    if (data.settings?.tmdbKey) await this.setSetting('tmdbKey', data.settings.tmdbKey);
  },
  // Replace local user data entirely (used when remote is newer).
  async replaceAll(data) {
    for (const s of DATA_STORES) await this.clearStore(s);
    await this.importAll(data);
  }
};
