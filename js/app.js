import { db } from './db.js';
import * as api from './api.js';
import { IMG } from './api.js';
import * as store from './store.js';

// ---------- helpers ----------
const $ = (sel) => document.querySelector(sel);
const view = $('#view');
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1900);
}
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function poster(path, cls = 'poster', glyph = '▦') {
  const url = IMG.poster(path);
  return url ? `<img class="${cls}" loading="lazy" src="${url}" alt="">`
             : `<div class="${cls} poster--ph">${glyph}</div>`;
}
function fmtDate(iso, opts) {
  if (!iso) return '';
  return new Date(iso + 'T00:00:00').toLocaleDateString(undefined, opts || { month: 'short', day: 'numeric', year: 'numeric' });
}
function dayLabel(iso) {
  const t = new Date(); t.setHours(0, 0, 0, 0);
  const diff = Math.round((new Date(iso + 'T00:00:00') - t) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff > 1 && diff < 7) return new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long' });
  return '';
}
const sxe = (s, e) => `S${s}E${e}`;
const isMovieId = (id) => id.startsWith('movie:');

function tvStatusPill(show) {
  if (/canceled|cancelled/i.test(show.status)) return `<span class="pill pill--warn">Canceled</span>`;
  if (store.isEnded(show)) return `<span class="pill">Ended</span>`;
  return `<span class="pill pill--good">Ongoing</span>`;
}

// ---------- routing ----------
const DEFAULT_SUB = { tv: 'upnext', movies: 'upnext', you: 'home', search: null };
let route = { sec: 'tv', sub: 'upnext' };
let detailId = null;
let prev = { sec: 'tv', sub: 'upnext' };
const tempItems = new Map(); // fetched-but-not-saved records, keyed by composite id

function go(sec) {
  route = { sec, sub: DEFAULT_SUB[sec] };
  detailId = null; window.scrollTo(0, 0); syncTabs(); render();
}
function setSub(sub) { route.sub = sub; window.scrollTo(0, 0); render(); }
function openDetail(id) { prev = { ...route }; detailId = id; window.scrollTo(0, 0); render(); }
function back() { detailId = null; route = { ...prev }; syncTabs(); render(); }
function syncTabs() {
  document.querySelectorAll('.tab').forEach((b) =>
    b.classList.toggle('active', b.dataset.sec === route.sec && detailId == null));
}

// ---------- shared bits ----------
function segmented(opts) {
  return `<div class="segmented">${opts.map((o) =>
    `<button data-sub="${o.sub}" class="${route.sub === o.sub ? 'active' : ''}">${o.label}</button>`).join('')}</div>`;
}
function spinner() { view.innerHTML = '<div class="spinner"></div>'; }
function empty(emoji, title, ...lines) {
  return `<div class="empty"><div class="empty__emoji">${emoji}</div>
    <p class="empty__title">${esc(title)}</p>${lines.map((l) => `<p>${l}</p>`).join('')}</div>`;
}
function errorBox(err) {
  const m = String(err && err.message || err);
  if (m === 'NO_KEY' || m === 'BAD_KEY') return empty('🔑', 'API key problem',
    'Your TMDB key is missing or invalid.', '<button class="btn btn--accent mt16" id="fixKey">Open Settings</button>');
  return empty('⚠️', 'Something went wrong', esc(m), 'Check your connection and try again.');
}

// ---------- render dispatch ----------
async function render() {
  if (detailId != null) return isMovieId(detailId) ? renderMovieDetail(detailId) : renderTvDetail(detailId);
  if (!api.hasKey()) return renderNeedKey();
  switch (route.sec) {
    case 'tv': return route.sub === 'calendar' ? renderTvCalendar() : renderTvUpNext();
    case 'movies': return route.sub === 'calendar' ? renderMovieCalendar() : renderMovieUpNext();
    case 'search': return renderSearch();
    case 'you':
      if (route.sub === 'all-tv') return renderFullList('tv');
      if (route.sub === 'all-movies') return renderFullList('movie');
      return renderYouHome();
  }
}

function renderNeedKey() {
  view.innerHTML = empty('🔑', 'Add your TMDB key to start',
    'Tally pulls TV & movie data from The Movie Database (free).',
    '<button class="btn btn--accent mt16" id="openSettings">Open Settings</button>');
  $('#openSettings').onclick = openSettings;
}

// ---------- TV: Up Next ----------
function renderTvUpNext() {
  const next = store.tvUpNext();
  const caught = store.tvCaughtUp();
  let html = segmented([{ sub: 'upnext', label: 'Up Next' }, { sub: 'calendar', label: 'Calendar' }]);
  if (!next.length && !caught.length) {
    html += empty('🍿', 'No shows yet', 'Add a show from Search to start tracking.',
      '<button class="btn btn--accent mt16" data-goto="search">Find a show</button>');
  } else {
    if (next.length) html += `<div class="section-title">Up Next</div>` + next.map(tvUpNextCard).join('');
    if (caught.length) html += `<div class="section-title">All caught up</div>` + caught.map((s) => {
      const p = store.progress(s);
      const ended = store.isEnded(s);
      return `<div class="row" data-open="${s.id}">
        ${poster(s.poster)}
        <div class="row__body">
          <p class="row__title">${esc(s.name)}</p>
          <p class="row__sub">${ended ? 'Finished' : 'Waiting for new episodes'}</p>
          <p class="row__meta">${p.watched}/${p.total} watched</p>
        </div>
        ${tvStatusPill(s)}
      </div>`;
    }).join('');
  }
  view.innerHTML = html;
}
function tvUpNextCard({ show, next }) {
  const { ep, season, episode } = next;
  return `<div class="row" data-open="${show.id}">
    ${poster(show.poster)}
    <div class="row__body">
      <p class="row__title">${esc(show.name)}</p>
      <p class="row__sub">${sxe(season, episode)} · ${esc(ep.name || 'Episode ' + episode)}</p>
      <p class="row__meta">${ep.air_date ? fmtDate(ep.air_date) : ''}</p>
    </div>
    <button class="ep__check" data-watch="${show.id}::${season}::${episode}" aria-label="Mark watched">✓</button>
  </div>`;
}

// ---------- TV: Calendar ----------
function renderTvCalendar() {
  let html = segmented([{ sub: 'upnext', label: 'Up Next' }, { sub: 'calendar', label: 'Calendar' }]);
  const items = store.tvCalendar();
  if (!items.length) { view.innerHTML = html + empty('📅', 'No upcoming episodes', 'New episodes for shows in your library will appear here.'); return; }
  const groups = {};
  for (const it of items) (groups[it.date] ||= []).push(it);
  html += Object.entries(groups).map(([date, list]) => `
    <div class="cal-day">
      <p class="cal-day__label">${dayLabel(date) ? dayLabel(date) + ' · ' : ''}${fmtDate(date, { weekday: 'short', month: 'short', day: 'numeric' })}</p>
      ${list.map((it) => `<div class="row" data-open="${it.show.id}">
        ${poster(it.show.poster)}
        <div class="row__body"><p class="row__title">${esc(it.show.name)}</p>
        <p class="row__sub">${sxe(it.season, it.episode)} · ${esc(it.ep.name || 'Episode ' + it.episode)}</p></div>
      </div>`).join('')}
    </div>`).join('');
  view.innerHTML = html;
}

// ---------- Movies: Up Next ----------
function renderMovieUpNext() {
  let html = segmented([{ sub: 'upnext', label: 'Up Next' }, { sub: 'calendar', label: 'Calendar' }]);
  const list = store.movieUpNext();
  if (!list.length) {
    html += empty('🎬', 'No movies queued', 'Add a movie from Search to build your watchlist.',
      '<button class="btn btn--accent mt16" data-goto="search">Find a movie</button>');
  } else {
    html += `<div class="section-title">To Watch</div>` + list.map((m) => {
      const upcoming = m.releaseDate && m.releaseDate > store.today();
      return `<div class="row" data-open="${m.id}">
        ${poster(m.poster, 'poster', '🎬')}
        <div class="row__body">
          <p class="row__title">${esc(m.name)}</p>
          <p class="row__sub">${(m.releaseDate || '').slice(0, 4) || '—'}${m.runtime ? ' · ' + m.runtime + 'm' : ''}</p>
          ${upcoming ? `<p class="row__meta" style="color:var(--warn)">Coming ${fmtDate(m.releaseDate)}</p>` : ''}
        </div>
        <button class="ep__check" data-moviewatch="${m.id}" aria-label="Mark watched">✓</button>
      </div>`;
    }).join('');
  }
  view.innerHTML = html;
}

// ---------- Movies: Calendar ----------
function renderMovieCalendar() {
  let html = segmented([{ sub: 'upnext', label: 'Up Next' }, { sub: 'calendar', label: 'Calendar' }]);
  const items = store.movieCalendar();
  if (!items.length) { view.innerHTML = html + empty('📅', 'No upcoming releases', 'Add an unreleased movie to your watchlist and its release date shows here.'); return; }
  const groups = {};
  for (const it of items) (groups[it.date] ||= []).push(it);
  html += Object.entries(groups).map(([date, list]) => `
    <div class="cal-day">
      <p class="cal-day__label">${dayLabel(date) ? dayLabel(date) + ' · ' : ''}${fmtDate(date, { weekday: 'short', month: 'short', day: 'numeric' })}</p>
      ${list.map((it) => `<div class="row" data-open="${it.movie.id}">
        ${poster(it.movie.poster, 'poster', '🎬')}
        <div class="row__body"><p class="row__title">${esc(it.movie.name)}</p>
        <p class="row__sub">Premieres</p></div>
      </div>`).join('')}
    </div>`).join('');
  view.innerHTML = html;
}

// ---------- Search (TV + movies) ----------
let searchTimer, lastQuery = '';
function renderSearch() {
  view.innerHTML = `<div class="search-bar"><input id="q" type="text" placeholder="Search TV & movies…" autocomplete="off" value="${esc(lastQuery)}"></div><div id="results"></div>`;
  const input = $('#q'); input.focus();
  input.oninput = () => { lastQuery = input.value; clearTimeout(searchTimer); searchTimer = setTimeout(() => doSearch(input.value), 300); };
  if (lastQuery.trim()) doSearch(lastQuery);
}
async function doSearch(q) {
  const box = $('#results'); if (!box) return;
  if (!q.trim()) { box.innerHTML = ''; return; }
  box.innerHTML = '<div class="spinner"></div>';
  try {
    const results = await api.searchMulti(q);
    if (!$('#results')) return;
    if (!results.length) { box.innerHTML = empty('🔍', 'No results', 'Try a different title.'); return; }
    box.innerHTML = results.map((r) => {
      const id = store.cid(r.mediaType, r.tmdbId);
      const glyph = r.mediaType === 'movie' ? '🎬' : '▦';
      return `<div class="row" data-open="${id}">
        ${poster(r.poster, 'poster', glyph)}
        <div class="row__body">
          <p class="row__title">${esc(r.name)}</p>
          <p class="row__sub"><span class="tag">${r.mediaType === 'movie' ? 'Movie' : 'TV'}</span> ${r.year || '—'}${store.inLibrary(id) ? ' · <span class="rating-inline">In library</span>' : ''}</p>
          <p class="row__meta">${esc((r.overview || '').slice(0, 80))}${r.overview && r.overview.length > 80 ? '…' : ''}</p>
        </div>
      </div>`;
    }).join('');
  } catch (err) { box.innerHTML = errorBox(err); const f = $('#fixKey'); if (f) f.onclick = openSettings; }
}

// ---------- You: home (Library preview + Stats) ----------
function renderYouHome() {
  const tv = store.tvByRecent();
  const mv = store.moviesByRecent();

  if (!tv.length && !mv.length) {
    view.innerHTML = empty('📚', 'Your library is empty', 'Add shows and movies from Search.',
      '<button class="btn btn--accent mt16" data-goto="search">Find something</button>');
    return;
  }

  let html = `<div class="section-title">Library</div>`;
  html += libPreview('tv', tv);
  html += libPreview('movie', mv);
  html += `<div class="section-title">Stats</div>` + statsHTML();
  view.innerHTML = html;
}

// A compact, horizontally-scrolling row (recently watched first) + "See all".
function libPreview(type, list) {
  const label = type === 'tv' ? '📺 TV Shows' : '🎬 Movies';
  const glyph = type === 'tv' ? '▦' : '🎬';
  const head = `<div class="lib-head">
    <span class="lib-head__label">${label}</span>
    ${list.length ? `<button class="link" data-goto-list="${type}">See all (${list.length}) ›</button>` : ''}
  </div>`;
  if (!list.length) {
    return head + `<p class="muted" style="font-size:13px;margin:0 0 6px">No ${type === 'tv' ? 'shows' : 'movies'} yet · <button class="link" data-goto="search">add one</button></p>`;
  }
  const cards = list.slice(0, 12).map((it) => {
    let meta;
    if (type === 'tv') { const n = store.nextEpisode(it); meta = n ? `S${n.season}E${n.episode}` : (store.isEnded(it) ? 'Finished' : 'Caught up'); }
    else meta = it.watchedAt ? '✓ Watched' : 'To watch';
    return `<div class="pcard" data-open="${it.id}">
      ${poster(it.poster, 'pcard__img', glyph)}
      <p class="pcard__title">${esc(it.name)}</p>
      <p class="pcard__meta">${meta}</p>
    </div>`;
  }).join('');
  return head + `<div class="hscroll">${cards}</div>`;
}

// ---------- You: full list for one type ----------
function renderFullList(type) {
  const list = type === 'tv' ? store.tvByRecent() : store.moviesByRecent();
  let html = `<button class="back-btn" data-you-home>‹ Library</button>`;
  html += `<div class="section-title">${type === 'tv' ? '📺 All TV Shows' : '🎬 All Movies'} · ${list.length}</div>`;
  html += list.length
    ? list.map(type === 'tv' ? tvLibRow : movieLibRow).join('')
    : empty(type === 'tv' ? '📺' : '🎬', 'Nothing here yet');
  view.innerHTML = html;
}
function tvLibRow(s) {
  const p = store.progress(s); const pct = p.aired ? Math.round((p.watched / p.aired) * 100) : 0;
  const rating = store.getRating(s.id);
  return `<div class="row" data-open="${s.id}">
    ${poster(s.poster)}
    <div class="row__body">
      <p class="row__title">${esc(s.name)}</p>
      <p class="row__sub">${p.watched}/${p.aired || p.total} eps${rating ? ` · <span class="rating-inline">${'★'.repeat(rating)}</span>` : ''}</p>
      <div class="progress"><div class="progress__fill" style="width:${pct}%"></div></div>
    </div>
    ${tvStatusPill(s)}
  </div>`;
}
function movieLibRow(m) {
  const rating = store.getRating(m.id);
  return `<div class="row" data-open="${m.id}">
    ${poster(m.poster, 'poster', '🎬')}
    <div class="row__body">
      <p class="row__title">${esc(m.name)}</p>
      <p class="row__sub">${(m.releaseDate || '').slice(0, 4) || '—'}${rating ? ` · <span class="rating-inline">${'★'.repeat(rating)}</span>` : ''}</p>
    </div>
    <span class="pill ${m.watchedAt ? 'pill--good' : ''}">${m.watchedAt ? '✓ Watched' : 'To watch'}</span>
  </div>`;
}

// ---------- You: Stats ----------
function statGrid(rows) {
  return `<div class="stat-grid">${rows.map((r) =>
    `<div class="stat"><div class="stat__num ${r.cls || ''}">${r.n}</div><div class="stat__label">${r.l}</div></div>`).join('')}</div>`;
}
function statsHTML() {
  const t = store.tvStats(), m = store.movieStats();
  return `<p class="subhead">📺 TV</p>` + statGrid([
    { n: t.episodes, l: 'Episodes', cls: 'stat__num--accent' },
    { n: t.hours, l: 'Hours', cls: 'stat__num--good' },
    { n: t.days, l: 'Days' },
    { n: t.tracking, l: 'Tracking' },
    { n: t.completed, l: 'Completed' },
    { n: t.avgRating || '—', l: `Avg ★${t.ratingsCount ? ` (${t.ratingsCount})` : ''}`, cls: 'stat__num--star' }
  ]) + `<p class="subhead">🎬 Movies</p>` + statGrid([
    { n: m.watched, l: 'Watched', cls: 'stat__num--accent' },
    { n: m.hours, l: 'Hours', cls: 'stat__num--good' },
    { n: m.days, l: 'Days' },
    { n: m.watchlist, l: 'To watch' },
    { n: m.avgRating || '—', l: `Avg ★${m.ratingsCount ? ` (${m.ratingsCount})` : ''}`, cls: 'stat__num--star' }
  ]);
}

// ---------- Detail: shared hero ----------
function heroHTML(item, metaLine, glyph) {
  const bg = IMG.backdrop(item.backdrop);
  return `<button class="back-btn" data-back>‹ Back</button>
    <div class="detail-hero">
      ${bg ? `<img class="detail-hero__bg" src="${bg}" alt="">` : `<div class="detail-hero__bg--ph"></div>`}
      <div class="detail-hero__grad"></div>
      <div class="detail-hero__row">
        ${poster(item.poster, 'poster poster--lg', glyph)}
        <div class="grow">
          <h2 class="detail-hero__title">${esc(item.name)}</h2>
          <p class="detail-hero__meta">${metaLine}</p>
        </div>
      </div>
    </div>`;
}
function starsHTML(id) {
  const rating = store.getRating(id);
  return `<div class="stars" data-rate>${[1, 2, 3, 4, 5].map((n) =>
    `<button data-star="${n}" class="${n <= rating ? 'on' : ''}">★</button>`).join('')}</div>`;
}

// ---------- Detail: TV ----------
async function renderTvDetail(id) {
  let show = store.getItem(id) || tempItems.get(id);
  const saved = store.inLibrary(id);
  if (!show) {
    spinner();
    try { show = await api.getShowFull(Number(id.split(':')[1])); tempItems.set(id, { ...show, id }); }
    catch (err) { view.innerHTML = `<button class="back-btn" data-back>‹ Back</button>` + errorBox(err); const f = $('#fixKey'); if (f) f.onclick = openSettings; return; }
    if (detailId !== id) return;
  }

  const p = store.progress(show);
  const pct = p.aired ? Math.round((p.watched / p.aired) * 100) : 0;
  const allWatched = p.aired > 0 && p.watched >= p.aired;
  const meta = `${(show.firstAirDate || '').slice(0, 4) || ''}${(show.genres || []).length ? ' · ' + esc(show.genres.slice(0, 2).join(', ')) : ''} ${tvStatusPill(show)}`;

  let actions;
  if (!saved) {
    actions = `<div class="btn-row">
      <button class="btn btn--accent grow" data-add="watching">＋ Start watching</button>
      <button class="btn grow" data-add="watchlist">☆ Watchlist</button>
    </div>
    <button class="btn btn--good btn--block mt8" data-add-all>✓ I've watched the whole show</button>`;
  } else {
    actions = `
      <div class="hstack" style="justify-content:space-between">${starsHTML(id)}<span class="pill">${p.watched}/${p.aired || p.total} watched</span></div>
      <div class="progress mt8"><div class="progress__fill" style="width:${pct}%"></div></div>
      <button class="btn ${allWatched ? '' : 'btn--good'} btn--block mt16" data-showwatch data-on="${allWatched ? '0' : '1'}">
        ${allWatched ? 'Unmark whole show' : '✓ Mark whole show watched'}</button>`;
  }

  const overview = show.overview ? `<p class="muted mt16" style="font-size:14px;line-height:1.5">${esc(show.overview)}</p>` : '';

  const seasons = (show.seasons || []).map((season) => {
    const w = season.episodes.filter((e) => store.isWatched(id, season.season_number, e.episode_number)).length;
    const aired = season.episodes.filter((e) => e.air_date && e.air_date <= store.today()).length;
    const seasonAll = aired > 0 && w >= aired;
    const open = store.nextEpisode(show)?.season === season.season_number;
    return `<div class="season${open ? ' open' : ''}" data-season="${season.season_number}">
      <button class="season__head" data-toggle-season>
        <span class="chevron">▶</span><span class="season__title">${esc(season.name)}</span>
        <span class="season__count">${w}/${season.episodes.length}</span>
      </button>
      <div class="episodes">
        ${saved ? `<div style="padding:8px 14px;border-top:1px solid var(--line)">
          <button class="btn btn--sm" data-season-toggle="${season.season_number}" data-on="${seasonAll ? '0' : '1'}">${seasonAll ? 'Unmark season' : 'Mark season watched'}</button></div>` : ''}
        ${season.episodes.map((e) => epRow(id, season.season_number, e, saved)).join('')}
      </div>
    </div>`;
  }).join('');

  let footer = '';
  if (saved) footer = `<div class="btn-row mt16">
    ${show.listType === 'watchlist'
      ? `<button class="btn btn--accent grow" data-move="watching">Move to Watching</button>`
      : `<button class="btn grow" data-move="watchlist">Move to Watchlist</button>`}
    <button class="btn btn--ghost" data-remove style="color:var(--danger)">Remove</button></div>`;

  view.innerHTML = heroHTML(show, meta, '▦') + actions + overview + `<div class="section-title">Episodes</div>` + seasons + footer;
}
function epRow(id, seasonNumber, e, saved) {
  const watched = store.isWatched(id, seasonNumber, e.episode_number);
  const aired = e.air_date && e.air_date <= store.today();
  const future = e.air_date && !aired;
  return `<div class="ep ${watched ? 'watched' : ''} ${future ? 'ep--future' : ''}">
    <button class="ep__check ${watched ? 'on' : ''}" ${saved ? '' : 'disabled style="opacity:.35"'} data-watch="${id}::${seasonNumber}::${e.episode_number}">✓</button>
    <div class="ep__body">
      <p class="ep__title">${e.episode_number}. ${esc(e.name || 'Episode ' + e.episode_number)}</p>
      <p class="ep__sub">${future ? 'Airs ' + fmtDate(e.air_date) : (e.air_date ? fmtDate(e.air_date) : 'TBA')}${e.runtime ? ' · ' + e.runtime + 'm' : ''}</p>
    </div>
  </div>`;
}

// ---------- Detail: Movie ----------
async function renderMovieDetail(id) {
  let m = store.getItem(id) || tempItems.get(id);
  const saved = store.inLibrary(id);
  if (!m) {
    spinner();
    try { m = await api.getMovieFull(Number(id.split(':')[1])); tempItems.set(id, { ...m, id }); }
    catch (err) { view.innerHTML = `<button class="back-btn" data-back>‹ Back</button>` + errorBox(err); const f = $('#fixKey'); if (f) f.onclick = openSettings; return; }
    if (detailId !== id) return;
  }

  const upcoming = m.releaseDate && m.releaseDate > store.today();
  const statusPill = upcoming ? `<span class="pill pill--warn">Coming ${fmtDate(m.releaseDate)}</span>`
    : (m.watchedAt ? `<span class="pill pill--good">✓ Watched</span>` : '');
  const meta = `${(m.releaseDate || '').slice(0, 4) || ''}${m.runtime ? ' · ' + m.runtime + 'm' : ''}${(m.genres || []).length ? ' · ' + esc(m.genres.slice(0, 2).join(', ')) : ''} ${statusPill}`;

  let actions;
  if (!saved) {
    actions = `<div class="btn-row">
      <button class="btn btn--good grow" data-add-movie="watched">✓ Watched it</button>
      <button class="btn btn--accent grow" data-add-movie="watchlist">☆ Watchlist</button>
    </div>`;
  } else {
    actions = `<div class="hstack" style="justify-content:space-between">${starsHTML(id)}${statusPill || '<span></span>'}</div>
      <button class="btn ${m.watchedAt ? '' : 'btn--good'} btn--block mt16" data-moviewatch="${id}">
        ${m.watchedAt ? 'Mark as unwatched' : '✓ Mark watched'}</button>
      <div class="btn-row mt8"><button class="btn btn--ghost btn--block" data-remove style="color:var(--danger)">Remove</button></div>`;
  }
  const overview = m.overview ? `<p class="muted mt16" style="font-size:14px;line-height:1.5">${esc(m.overview)}</p>` : '';
  view.innerHTML = heroHTML(m, meta, '🎬') + actions + overview;
}

// ---------- click handling ----------
document.addEventListener('click', async (ev) => {
  const t = ev.target;

  if (t.id === 'fixKey' || t.id === 'openSettings') return openSettings();

  const gotoEl = t.closest('[data-goto]');
  if (gotoEl) return go(gotoEl.dataset.goto);

  // Open the full list for a media type (from the You/Library preview)
  const listEl = t.closest('[data-goto-list]');
  if (listEl) { route = { sec: 'you', sub: listEl.dataset.gotoList === 'tv' ? 'all-tv' : 'all-movies' }; window.scrollTo(0, 0); return render(); }

  // Back from a full list to the Library home
  if (t.closest('[data-you-home]')) { route = { sec: 'you', sub: 'home' }; syncTabs(); window.scrollTo(0, 0); return render(); }

  if (t.closest('[data-back]')) return back();

  const subEl = t.closest('[data-sub]');
  if (subEl) return setSub(subEl.dataset.sub);

  // Toggle a TV episode (keys use '::' since ids contain ':')
  const watchEl = t.closest('[data-watch]');
  if (watchEl) {
    ev.stopPropagation();
    const [id, s, e] = watchEl.dataset.watch.split('::');
    const on = await store.toggleWatched(id, Number(s), Number(e));
    toast(on ? 'Marked watched' : 'Unmarked');
    return render();
  }

  // Toggle a movie watched
  const mwEl = t.closest('[data-moviewatch]');
  if (mwEl) {
    ev.stopPropagation();
    const on = await store.toggleMovieWatched(mwEl.dataset.moviewatch);
    toast(on ? 'Marked watched' : 'Marked unwatched');
    return render();
  }

  const seasonHead = t.closest('[data-toggle-season]');
  if (seasonHead) { seasonHead.closest('.season').classList.toggle('open'); return; }

  const seasonToggle = t.closest('[data-season-toggle]');
  if (seasonToggle) { ev.stopPropagation(); await store.setSeasonWatched(detailId, Number(seasonToggle.dataset.seasonToggle), seasonToggle.dataset.on === '1'); return render(); }

  if (t.closest('[data-showwatch]')) {
    const on = t.closest('[data-showwatch]').dataset.on === '1';
    await store.setShowWatched(detailId, on); toast(on ? 'Whole show marked watched' : 'Unmarked'); return render();
  }

  const star = t.closest('[data-star]');
  if (star) { const n = Number(star.dataset.star); const cur = store.getRating(detailId); await store.setRating(detailId, cur === n ? 0 : n); return render(); }

  // Add TV show
  const addEl = t.closest('[data-add]');
  if (addEl) { const rec = tempItems.get(detailId) || store.getItem(detailId); if (rec) { await store.addItem(rec, addEl.dataset.add); toast('Added to ' + (addEl.dataset.add === 'watching' ? 'Watching' : 'Watchlist')); render(); } return; }

  // Add TV show as fully watched
  if (t.closest('[data-add-all]')) {
    const rec = tempItems.get(detailId); if (rec) { await store.addItem(rec, 'watching'); await store.setShowWatched(detailId, true); toast('Added — whole show watched'); render(); }
    return;
  }

  // Add movie (watched or watchlist)
  const addMovie = t.closest('[data-add-movie]');
  if (addMovie) {
    const rec = tempItems.get(detailId); if (!rec) return;
    await store.addItem(rec, 'watchlist');
    if (addMovie.dataset.addMovie === 'watched') { await store.toggleMovieWatched(detailId, true); toast('Added — watched'); }
    else toast('Added to Watchlist');
    return render();
  }

  const moveEl = t.closest('[data-move]');
  if (moveEl) { await store.setListType(detailId, moveEl.dataset.move); toast('Moved'); return render(); }

  if (t.closest('[data-remove]')) {
    if (confirm('Remove this and its history?')) { const id = detailId; detailId = null; route = { ...prev }; await store.removeItem(id); syncTabs(); toast('Removed'); return render(); }
    return;
  }

  const openEl = t.closest('[data-open]');
  if (openEl) return openDetail(openEl.dataset.open);
});

// ---------- Settings modal ----------
function openSettings() {
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  wrap.innerHTML = `
    <div class="modal">
      <div class="modal__handle"></div>
      <h2>Settings</h2>
      <label for="keyInput">TMDB API Key or Read Access Token</label>
      <input id="keyInput" type="text" placeholder="Paste your key…" value="${esc(api.hasKey() ? '••••••••••••' : '')}">
      <p>Free from <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener">themoviedb.org</a> → Settings → API. Paste the <b>API Key (v3)</b> or the <b>Read Access Token (v4)</b>. Stored only on this device.</p>
      <div class="btn-row"><button class="btn btn--accent grow" id="saveKey">Save key</button></div>
      <label>Backup</label>
      <div class="btn-row">
        <button class="btn grow" id="exportBtn">Export data</button>
        <button class="btn grow" id="importBtn">Import data</button>
        <input id="importFile" type="file" accept="application/json" hidden>
      </div>
      <label>Install on iPhone</label>
      <p>Open this page in <b>Safari</b> → tap <b>Share</b> → <b>Add to Home Screen</b>. Tally then opens fullscreen like a native app.</p>
      <div class="btn-row mt16"><button class="btn btn--ghost btn--block" id="closeSettings">Close</button></div>
      <p class="center muted" style="font-size:12px;margin-top:14px">Tally · a private, social-free TV & movie tracker</p>
    </div>`;
  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
  wrap.querySelector('#closeSettings').onclick = close;
  wrap.querySelector('#saveKey').onclick = async () => {
    const val = wrap.querySelector('#keyInput').value.trim();
    if (!val || val.startsWith('•')) { toast('Enter a key'); return; }
    await api.setKey(val); toast('Key saved'); close(); render();
  };
  wrap.querySelector('#exportBtn').onclick = async () => {
    const blob = new Blob([JSON.stringify(await db.exportAll(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `tally-backup-${new Date().toISOString().slice(0, 10)}.json`; a.click(); URL.revokeObjectURL(a.href);
  };
  wrap.querySelector('#importBtn').onclick = () => wrap.querySelector('#importFile').click();
  wrap.querySelector('#importFile').onchange = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    try { await db.importAll(JSON.parse(await file.text())); await store.loadState(); toast('Data imported'); close(); render(); }
    catch (_) { toast('Import failed'); }
  };
}

// ---------- init ----------
async function init() {
  document.querySelectorAll('.tab').forEach((b) => (b.onclick = () => go(b.dataset.sec)));
  $('#settingsBtn').onclick = openSettings;
  $('#brand').onclick = () => go('tv');
  await api.loadKey();
  await store.loadState();
  syncTabs(); render();
  if ('serviceWorker' in navigator) { try { await navigator.serviceWorker.register('./sw.js'); } catch (_) {} }
}
init();
