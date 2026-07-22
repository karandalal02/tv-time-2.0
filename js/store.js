// App state + tracking logic. Holds an in-memory cache mirrored to IndexedDB.
// Items (TV shows and movies) share one store, keyed by a composite id like
// 'tv:1399' or 'movie:27205', so TV and movie TMDB ids never collide.
import { db } from './db.js';

export const cid = (mediaType, tmdbId) => `${mediaType}:${tmdbId}`;
export const epKey = (id, s, e) => `${id}:${s}:${e}`;
export const today = () => new Date().toISOString().slice(0, 10);
const isAired = (d) => !!d && d <= today();

const state = {
  items: new Map(),    // id -> record (tv or movie)
  watched: new Map(),  // 'id:s:e' -> ISO timestamp (TV episodes only)
  ratings: new Map()   // id -> rating (1-5)
};

// One-time migration from the original v1 schema (numeric TMDB ids, TV-only).
async function migrateLegacy() {
  const shows = await db.getAll('shows');
  const legacy = shows.filter((s) => !s.mediaType);
  if (!legacy.length) return;
  for (const s of legacy) {
    const oldId = s.id, newId = cid('tv', oldId);
    await db.del('shows', oldId);
    Object.assign(s, { tmdbId: oldId, mediaType: 'tv', id: newId });
    await db.put('shows', s);
  }
  for (const w of await db.getAll('watched')) {
    if (typeof w.showId === 'number') {
      await db.del('watched', w.key);
      const newShowId = cid('tv', w.showId);
      Object.assign(w, { showId: newShowId, key: epKey(newShowId, w.season, w.episode) });
      await db.put('watched', w);
    }
  }
  for (const r of await db.getAll('ratings')) {
    if (typeof r.showId === 'number') {
      await db.del('ratings', r.showId);
      await db.put('ratings', { ...r, showId: cid('tv', r.showId) });
    }
  }
}

export async function loadState() {
  await migrateLegacy();
  state.items.clear(); state.watched.clear(); state.ratings.clear();
  for (const s of await db.getAll('shows')) state.items.set(s.id, s);
  for (const w of await db.getAll('watched')) state.watched.set(w.key, w.at);
  for (const r of await db.getAll('ratings')) state.ratings.set(r.showId, r.rating);
}

// ---------- generic item helpers ----------
export const getItem = (id) => state.items.get(id);
export const inLibrary = (id) => state.items.has(id);
const items = (mediaType) => [...state.items.values()].filter((x) => x.mediaType === mediaType);
export const tvShows = () => items('tv');
export const movies = () => items('movie');

export async function addItem(record, listType) {
  const id = cid(record.mediaType, record.tmdbId);
  const rec = { ...record, id, listType, addedAt: Date.now() };
  state.items.set(id, rec);
  await db.put('shows', rec);
  return rec;
}
export async function setListType(id, listType) {
  const s = state.items.get(id); if (!s) return;
  s.listType = listType; await db.put('shows', s);
}
export async function removeItem(id) {
  state.items.delete(id); state.ratings.delete(id);
  await db.del('shows', id); await db.del('ratings', id);
  for (const key of [...state.watched.keys()]) if (key.startsWith(id + ':')) state.watched.delete(key);
  await db.delWhere('watched', (w) => w.showId === id);
}

// ---------- ratings ----------
export const getRating = (id) => state.ratings.get(id) || 0;
export async function setRating(id, rating) {
  if (rating > 0) { state.ratings.set(id, rating); await db.put('ratings', { showId: id, rating, at: new Date().toISOString() }); }
  else { state.ratings.delete(id); await db.del('ratings', id); }
}

// ---------- TV: episodes & progress ----------
export const isWatched = (id, s, e) => state.watched.has(epKey(id, s, e));

export async function toggleWatched(id, s, e, on) {
  const key = epKey(id, s, e);
  const want = on == null ? !state.watched.has(key) : on;
  if (want) {
    state.watched.set(key, new Date().toISOString());
    await db.put('watched', { key, showId: id, season: s, episode: e, at: state.watched.get(key) });
    const show = state.items.get(id);
    if (show && show.listType === 'watchlist') await setListType(id, 'watching');
  } else {
    state.watched.delete(key);
    await db.del('watched', key);
  }
  return want;
}

export async function setSeasonWatched(id, seasonNumber, on) {
  const show = state.items.get(id); if (!show) return;
  const season = (show.seasons || []).find((s) => s.season_number === seasonNumber); if (!season) return;
  for (const ep of season.episodes) {
    if (on && !isAired(ep.air_date)) continue;
    await toggleWatched(id, seasonNumber, ep.episode_number, on);
  }
}

// Mark (or unmark) every aired episode of the whole show.
export async function setShowWatched(id, on) {
  const show = state.items.get(id); if (!show) return;
  for (const season of show.seasons || []) {
    for (const ep of season.episodes) {
      if (on && !isAired(ep.air_date)) continue;
      await toggleWatched(id, season.season_number, ep.episode_number, on);
    }
  }
  if (on) await setListType(id, 'watching');
}

export function progress(show) {
  let total = 0, aired = 0, watched = 0;
  for (const season of show.seasons || []) {
    for (const ep of season.episodes) {
      total++;
      if (isAired(ep.air_date)) aired++;
      if (isWatched(show.id, season.season_number, ep.episode_number)) watched++;
    }
  }
  return { total, aired, watched };
}

// Is the show finished airing (Ended / Canceled)?
export const isEnded = (show) => /ended|canceled|cancelled/i.test(show.status || '');

export function isCompleted(show) {
  const p = progress(show);
  return p.aired > 0 && p.watched >= p.aired && isEnded(show);
}

export function nextEpisode(show) {
  for (const season of show.seasons || []) {
    for (const ep of season.episodes) {
      if (isAired(ep.air_date) && !isWatched(show.id, season.season_number, ep.episode_number)) {
        return { season: season.season_number, episode: ep.episode_number, ep };
      }
    }
  }
  return null;
}

function lastActivity(id) {
  let latest = 0;
  for (const [key, at] of state.watched) if (key.startsWith(id + ':')) latest = Math.max(latest, Date.parse(at) || 0);
  return latest;
}

// ---------- TV lists ----------
export function tvUpNext() {
  return tvShows()
    .filter((s) => s.listType === 'watching')
    .map((s) => ({ show: s, next: nextEpisode(s) }))
    .filter((x) => x.next)
    .sort((a, b) => (lastActivity(b.show.id) - lastActivity(a.show.id)) || (b.show.addedAt - a.show.addedAt));
}
export function tvCaughtUp() {
  return tvShows()
    .filter((s) => s.listType === 'watching' && !nextEpisode(s))
    .sort((a, b) => a.name.localeCompare(b.name));
}
export function tvWatchlist() {
  return tvShows().filter((s) => s.listType === 'watchlist').sort((a, b) => b.addedAt - a.addedAt);
}
// All shows, most-recently-watched first (falls back to when added).
export function tvByRecent() {
  return tvShows().slice().sort((a, b) =>
    (lastActivity(b.id) - lastActivity(a.id)) || (b.addedAt - a.addedAt));
}
export function tvCalendar() {
  const t = today(), out = [];
  for (const show of tvShows()) {
    for (const season of show.seasons || []) {
      for (const ep of season.episodes) {
        if (ep.air_date && ep.air_date >= t) out.push({ show, season: season.season_number, episode: ep.episode_number, ep, date: ep.air_date });
      }
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// ---------- Movies ----------
export const isMovieWatched = (m) => !!m.watchedAt;

export async function toggleMovieWatched(id, on) {
  const m = state.items.get(id); if (!m) return;
  const want = on == null ? !m.watchedAt : on;
  m.watchedAt = want ? new Date().toISOString() : null;
  await db.put('shows', m);
  return want;
}

// Movies you want to watch (not watched yet). Released first, then upcoming.
export function movieUpNext() {
  const t = today();
  return movies()
    .filter((m) => !m.watchedAt)
    .sort((a, b) => {
      const au = (a.releaseDate || '') > t, bu = (b.releaseDate || '') > t; // upcoming?
      if (au !== bu) return au ? 1 : -1;
      return b.addedAt - a.addedAt;
    });
}
export function moviesWatched() {
  return movies().filter((m) => m.watchedAt).sort((a, b) => (b.watchedAt || '').localeCompare(a.watchedAt || ''));
}
// All movies, most-recently-watched first (falls back to when added).
export function moviesByRecent() {
  return movies().slice().sort((a, b) => {
    const ra = a.watchedAt ? Date.parse(a.watchedAt) : a.addedAt;
    const rb = b.watchedAt ? Date.parse(b.watchedAt) : b.addedAt;
    return rb - ra;
  });
}
export function movieCalendar() {
  const t = today();
  return movies()
    .filter((m) => m.releaseDate && m.releaseDate >= t)
    .map((m) => ({ movie: m, date: m.releaseDate }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ---------- Stats ----------
export function tvStats() {
  const epIndex = new Map();
  for (const show of tvShows())
    for (const season of show.seasons || [])
      for (const ep of season.episodes)
        epIndex.set(epKey(show.id, season.season_number, ep.episode_number), { ep, show });

  let minutes = 0, epCount = 0;
  for (const key of state.watched.keys()) {
    if (!key.startsWith('tv:')) continue;
    epCount++;
    const hit = epIndex.get(key);
    minutes += hit ? (hit.ep.runtime || hit.show.defaultRuntime || 40) : 40;
  }
  const ratingsArr = tvShows().map((s) => state.ratings.get(s.id)).filter(Boolean);
  return {
    episodes: epCount,
    hours: Math.round(minutes / 60),
    days: (minutes / 60 / 24).toFixed(1),
    tracking: tvShows().filter((s) => s.listType === 'watching').length,
    watchlist: tvWatchlist().length,
    completed: tvShows().filter(isCompleted).length,
    avgRating: ratingsArr.length ? (ratingsArr.reduce((a, b) => a + b, 0) / ratingsArr.length).toFixed(1) : null,
    ratingsCount: ratingsArr.length
  };
}
export function movieStats() {
  const watched = moviesWatched();
  let minutes = 0;
  for (const m of watched) minutes += m.runtime || 110;
  const ratingsArr = movies().map((m) => state.ratings.get(m.id)).filter(Boolean);
  return {
    watched: watched.length,
    hours: Math.round(minutes / 60),
    days: (minutes / 60 / 24).toFixed(1),
    watchlist: movies().filter((m) => !m.watchedAt).length,
    avgRating: ratingsArr.length ? (ratingsArr.reduce((a, b) => a + b, 0) / ratingsArr.length).toFixed(1) : null,
    ratingsCount: ratingsArr.length
  };
}
