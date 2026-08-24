// App state + tracking logic. Holds an in-memory cache mirrored to IndexedDB.
// Items (TV shows and movies) share one store, keyed by a composite id like
// 'tv:1399' or 'movie:27205', so TV and movie TMDB ids never collide.
import { db } from './db.js';

export const cid = (mediaType, tmdbId) => `${mediaType}:${tmdbId}`;
export const epKey = (id, s, e) => `${id}:${s}:${e}`;
// Local calendar date, not UTC — toISOString() would roll over to "tomorrow"
// hours early for anyone west of UTC (e.g. ~8pm-midnight local in US time
// zones), making a not-yet-aired episode look aired.
export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const isAired = (d) => !!d && d <= today();

const state = {
  items: new Map(),    // id -> record (tv or movie)
  watched: new Map(),  // 'id:s:e' -> ISO timestamp (TV episodes only)
  ratings: new Map(),  // id -> rating (1-5)
  lists: new Map()     // id -> { id, name, itemIds, createdAt }
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
  state.items.clear(); state.watched.clear(); state.ratings.clear(); state.lists.clear();
  for (const s of await db.getAll('shows')) state.items.set(s.id, s);
  for (const w of await db.getAll('watched')) state.watched.set(w.key, w.at);
  for (const r of await db.getAll('ratings')) state.ratings.set(r.showId, r.rating);
  for (const l of await db.getAll('lists')) state.lists.set(l.id, l);
  await reconcileQueueRanks();
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
  // List membership is a subset of tracked items — untracking must not leave
  // a dangling reference behind (would silently miscount a list's items).
  for (const l of listsContaining(id)) await removeFromList(l.id, id);
}

// ---------- ratings ----------
export const getRating = (id) => state.ratings.get(id) || 0;
export async function setRating(id, rating) {
  if (rating > 0) { state.ratings.set(id, rating); await db.put('ratings', { showId: id, rating, at: new Date().toISOString() }); }
  else { state.ratings.delete(id); await db.del('ratings', id); }
}
// Rating only makes sense once you've actually watched something — at least
// one episode for a show, or the whole thing for a movie (binary, no partial
// state). An unsaved/preview item always has zero watched by construction
// (episodes can't be marked watched until it's in the library), so this is
// naturally false for anything not yet added — no separate check needed.
export function canRate(item) {
  return item.mediaType === 'movie' ? !!item.watchedAt : progress(item).watched >= 1;
}
// Persists a fetched IMDb rating onto an already-saved item. A no-op for
// unsaved/preview items — the caller (app.js) holds those in memory only and
// mutates them directly; they get cached for real once actually added.
export async function cacheImdbRating(id, rating) {
  const item = state.items.get(id);
  if (!item) return;
  item.imdbRating = rating;
  await db.put('shows', item);
}

// ---------- TV: episodes & progress ----------
export const isWatched = (id, s, e) => state.watched.has(epKey(id, s, e));

export async function toggleWatched(id, s, e, on, at) {
  const key = epKey(id, s, e);
  const want = on == null ? !state.watched.has(key) : on;
  if (want) {
    state.watched.set(key, at || new Date().toISOString());
    await db.put('watched', { key, showId: id, season: s, episode: e, at: state.watched.get(key) });
    const show = state.items.get(id);
    if (show && (show.listType === 'watchlist' || show.listType === 'stopped')) await setListType(id, 'watching');
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

const DAY_MS = 24 * 60 * 60 * 1000;
const daysSince = (dateStr) => dateStr ? (Date.now() - Date.parse(dateStr + 'T00:00:00')) / DAY_MS : Infinity;
const GRACE_DAYS = 7;
const tracked = () => tvShows().filter((s) => s.listType !== 'stopped');

// Was this show being anticipated — added to the library while still unaired
// — rather than added after the fact once it already existed? Only shows
// that were genuinely "Yet to Release" for this user get the release-grace
// treatment; adding an already-out show never grants it, no matter how
// recently it happened to air.
function wasAnticipated(show) {
  return !!show.firstAirDate && show.addedAt < Date.parse(show.firstAirDate + 'T00:00:00');
}
// A demoted show's rank is frozen the moment it falls out of grace, so it
// doesn't keep drifting as more days pass — it just sits where it landed
// until something else demotes above it. Checked once per load; idempotent.
export async function reconcileQueueRanks() {
  for (const s of tvShows()) {
    if (s.yetToStartRank || progress(s).watched > 0) continue;
    if (wasAnticipated(s) && progress(s).aired > 0 && daysSince(s.firstAirDate) > GRACE_DAYS) {
      s.yetToStartRank = Date.now();
      await db.put('shows', s);
    }
  }
}

// Watch Next is two stacked tiers:
//  1. Shows you were anticipating that just released, still unwatched, within
//     their 7-day grace window — always above everything else, no matter how
//     recent your actual watch activity is.
//  2. Shows with real progress — most recently watched first, as before.
export function tvWatchNext() {
  const inGrace = (s) => wasAnticipated(s) && progress(s).aired > 0 && daysSince(s.firstAirDate) <= GRACE_DAYS;
  const tier1 = tracked()
    .filter((s) => nextEpisode(s) && progress(s).watched === 0 && inGrace(s))
    .sort((a, b) => (b.firstAirDate || '').localeCompare(a.firstAirDate || ''));
  const tier2 = tracked()
    .map((s) => ({ show: s, watched: progress(s).watched }))
    .filter((x) => nextEpisode(x.show) && x.watched >= 1)
    .sort((a, b) => (lastActivity(b.show.id) - lastActivity(a.show.id)) || (b.show.addedAt - a.show.addedAt))
    .map((x) => x.show);
  return [...tier1, ...tier2].map((s) => ({ show: s, next: nextEpisode(s) }));
}
// Unwatched shows with an episode available, excluding anything still in its
// Watch Next grace window. Sorted by "when this became relevant to you" —
// either when you added it (shows added after they'd already aired), or when
// it fell out of grace (shows that were anticipated and then went unwatched)
// — both on the same timeline so they compare fairly against each other.
export function tvYetToStart() {
  const inGrace = (s) => wasAnticipated(s) && progress(s).aired > 0 && daysSince(s.firstAirDate) <= GRACE_DAYS;
  return tracked()
    .map((s) => ({ show: s, next: nextEpisode(s), watched: progress(s).watched }))
    .filter((x) => x.next && x.watched === 0 && !inGrace(x.show))
    .sort((a, b) => ((b.show.yetToStartRank || b.show.addedAt) - (a.show.yetToStartRank || a.show.addedAt)));
}
// Shows with no episode currently available AND at least one episode has
// already aired: finished, or waiting on a new one.
export function tvCaughtUp() {
  return tracked()
    .filter((s) => !nextEpisode(s) && progress(s).aired > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
}
// Shows that haven't premiered yet — zero aired episodes, so there's nothing
// to start or catch up on. Soonest-premiering first.
export function tvYetToRelease() {
  return tracked()
    .filter((s) => !nextEpisode(s) && progress(s).aired === 0)
    .sort((a, b) => (a.firstAirDate || '9999-99-99').localeCompare(b.firstAirDate || '9999-99-99'));
}
// Shows you've deliberately set aside — kept off Watch Next/Yet to Start/
// Caught Up so your active queue doesn't grow forever, without losing your
// watch history. Alphabetical; low-traffic section, no need for recency sort.
export function tvStopped() {
  return tvShows().filter((s) => s.listType === 'stopped').sort((a, b) => a.name.localeCompare(b.name));
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

export async function toggleMovieWatched(id, on, at) {
  const m = state.items.get(id); if (!m) return;
  const want = on == null ? !m.watchedAt : on;
  m.watchedAt = want ? (at || new Date().toISOString()) : null;
  await db.put('shows', m);
  return want;
}

// Movies to watch: unwatched AND already released. Newest release date first.
// Unreleased movies are intentionally excluded — they live only in the
// Future Releases (calendar) view.
export function movieUpNext() {
  const t = today();
  return movies()
    .filter((m) => !m.watchedAt && !(m.releaseDate && m.releaseDate > t))
    .sort((a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || ''));
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
// ---------- Lists ----------
// A list is a curated, user-named subset of tracked items — never a
// replacement for tracking. Adding to a list auto-adds an untracked item at
// the Watchlist floor state; it never changes an already-tracked item's
// status or progress. See [[tv-time-2-lists-feature-spec]].
const genListId = () => 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

export const getList = (id) => state.lists.get(id);
export const allLists = () => [...state.lists.values()].sort((a, b) => b.createdAt - a.createdAt);
export const listsContaining = (itemId) => allLists().filter((l) => l.itemIds.includes(itemId));

export async function createList(name) {
  const rec = { id: genListId(), name: name.trim(), itemIds: [], createdAt: Date.now() };
  state.lists.set(rec.id, rec);
  await db.put('lists', rec);
  return rec;
}
export async function renameList(id, name) {
  const l = state.lists.get(id); if (!l) return;
  l.name = name.trim();
  await db.put('lists', l);
}
export async function deleteList(id) {
  state.lists.delete(id);
  await db.del('lists', id);
}
export async function addToList(listId, itemId) {
  const l = state.lists.get(listId); if (!l || l.itemIds.includes(itemId)) return;
  l.itemIds.push(itemId);
  await db.put('lists', l);
}
export async function removeFromList(listId, itemId) {
  const l = state.lists.get(listId); if (!l) return;
  const i = l.itemIds.indexOf(itemId); if (i < 0) return;
  l.itemIds.splice(i, 1);
  await db.put('lists', l);
}

// A show's "release" for list ordering is its most recent *aired* episode,
// not its premiere — so an old show with a fresh episode jumps to the top.
function latestReleaseDate(it) {
  if (it.mediaType === 'movie') return it.releaseDate || '';
  let latest = '';
  for (const season of it.seasons || [])
    for (const ep of season.episodes)
      if (ep.air_date && ep.air_date <= today() && ep.air_date > latest) latest = ep.air_date;
  return latest || it.firstAirDate || '';
}
// Resolved, live item records for a list — descending by latest release.
export function listItems(listId) {
  const l = state.lists.get(listId); if (!l) return [];
  return l.itemIds.map((id) => state.items.get(id)).filter(Boolean)
    .sort((a, b) => latestReleaseDate(b).localeCompare(latestReleaseDate(a)));
}

// For the list-detail filter chips (All / Started / Watched / Not Started).
export function itemWatchState(it) {
  if (it.mediaType === 'movie') return it.watchedAt ? 'watched' : 'notstarted';
  const p = progress(it);
  if (p.watched === 0) return 'notstarted';
  if (p.aired > 0 && p.watched >= p.aired) return 'watched';
  return 'started';
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
