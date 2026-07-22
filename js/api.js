// TMDB API client. Runs entirely client-side (TMDB allows browser CORS).
// The user supplies their own free key in Settings; it's stored on-device.
// Supports both a v3 API key and a v4 Read Access Token (auto-detected).
import { db } from './db.js';
import { TMDB_KEY as DEFAULT_KEY } from './config.js';

const BASE = 'https://api.themoviedb.org/3';
export const IMG = {
  poster: (p, size = 'w342') => (p ? `https://image.tmdb.org/t/p/${size}${p}` : null),
  backdrop: (p, size = 'w780') => (p ? `https://image.tmdb.org/t/p/${size}${p}` : null)
};

let _key = null;       // key actually used for requests
let _personal = null;  // key the user entered (overrides the built-in one)
export async function loadKey() {
  _personal = await db.getSetting('tmdbKey', '');
  _key = _personal || DEFAULT_KEY;
  return _key;
}
export async function setKey(k) {
  _personal = (k || '').trim();
  await db.setSetting('tmdbKey', _personal);
  _key = _personal || DEFAULT_KEY;
}
export function hasKey() { return !!_key; }
export function usingBuiltInKey() { return !_personal && !!DEFAULT_KEY; }

// A v4 token is a long JWT with dots; a v3 key is a 32-char hex string.
function isV4(k) { return k && k.split('.').length === 3; }

async function call(path, params = {}) {
  if (!_key) throw new Error('NO_KEY');
  const url = new URL(BASE + path);
  Object.entries(params).forEach(([k, v]) => v != null && url.searchParams.set(k, v));
  const opts = { headers: { accept: 'application/json' } };
  if (isV4(_key)) opts.headers.authorization = `Bearer ${_key}`;
  else url.searchParams.set('api_key', _key);

  const res = await fetch(url, opts);
  if (res.status === 401) throw new Error('BAD_KEY');
  if (!res.ok) throw new Error('HTTP_' + res.status);
  return res.json();
}

// Search both TV and movies in one query.
export async function searchMulti(query) {
  if (!query.trim()) return [];
  const data = await call('/search/multi', { query, include_adult: 'false' });
  return (data.results || [])
    .filter((r) => r.media_type === 'tv' || r.media_type === 'movie')
    .sort((a, b) => (b.popularity || 0) - (a.popularity || 0))
    .map((r) => r.media_type === 'tv'
      ? { mediaType: 'tv', tmdbId: r.id, name: r.name, poster: r.poster_path,
          year: (r.first_air_date || '').slice(0, 4), overview: r.overview }
      : { mediaType: 'movie', tmdbId: r.id, name: r.title, poster: r.poster_path,
          year: (r.release_date || '').slice(0, 4), overview: r.overview });
}

// Full TV record with every season's episodes, ready to store locally.
export async function getShowFull(tmdbId) {
  const show = await call('/tv/' + tmdbId);
  const seasonNumbers = (show.seasons || [])
    .map((s) => s.season_number)
    .filter((n) => n >= 1); // skip season 0 (specials) by default

  const seasons = [];
  for (const n of seasonNumbers) {
    try {
      const s = await call(`/tv/${tmdbId}/season/${n}`);
      seasons.push({
        season_number: n,
        name: s.name || `Season ${n}`,
        episodes: (s.episodes || []).map((e) => ({
          episode_number: e.episode_number,
          name: e.name,
          air_date: e.air_date || null,
          runtime: e.runtime || show.episode_run_time?.[0] || null,
          still: e.still_path || null,
          overview: e.overview || ''
        }))
      });
    } catch (_) { /* skip a season that fails */ }
  }

  return {
    mediaType: 'tv',
    tmdbId: show.id,
    name: show.name,
    poster: show.poster_path,
    backdrop: show.backdrop_path,
    firstAirDate: show.first_air_date || null,
    lastAirDate: show.last_air_date || null,
    status: show.status || '',                 // Returning Series, Ended, Canceled…
    inProduction: !!show.in_production,
    overview: show.overview || '',
    genres: (show.genres || []).map((g) => g.name),
    defaultRuntime: show.episode_run_time?.[0] || null,
    seasons
  };
}

// Full movie record.
export async function getMovieFull(tmdbId) {
  const m = await call('/movie/' + tmdbId);
  return {
    mediaType: 'movie',
    tmdbId: m.id,
    name: m.title,
    poster: m.poster_path,
    backdrop: m.backdrop_path,
    releaseDate: m.release_date || null,
    status: m.status || '',                    // Released, Post Production, Planned…
    runtime: m.runtime || null,
    overview: m.overview || '',
    genres: (m.genres || []).map((g) => g.name)
  };
}
