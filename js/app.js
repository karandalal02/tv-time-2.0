import { db } from './db.js';
import * as api from './api.js';
import { IMG } from './api.js';
import * as store from './store.js';
import * as sync from './sync.js';

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
// A bare time (e.g. "3:45 PM") is misleading once it's not from today — it
// reads as recent even when it's actually days old, which is exactly what a
// stale-sync warning needs to avoid.
function lastSyncLabel(date) {
  const days = Math.floor((Date.now() - date.getTime()) / 86400000);
  if (days <= 0) return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}
const sxe = (s, e) => `S${s}E${e}`;
const isMovieId = (id) => id.startsWith('movie:');
const isListId = (id) => id.startsWith('list:');

// A prominent "releasing in X days" badge — the big number is the point,
// meant to build anticipation rather than just state a fact like a status pill.
function countdownBadge(dateStr) {
  if (!dateStr) return `<span class="pill">TBA</span>`;
  const days = Math.ceil((Date.parse(dateStr + 'T00:00:00') - Date.now()) / 86400000);
  if (days <= 0) return `<div class="countdown"><span class="countdown__num">Today</span></div>`;
  return `<div class="countdown"><span class="countdown__num">${days}</span><span class="countdown__label">day${days === 1 ? '' : 's'}</span></div>`;
}

// Personal-progress status, not real-world broadcast status — except once
// you're fully caught up, where "the show itself is done" (Ended/Canceled,
// folded together) is more useful than "Caught up", since nothing more is
// ever coming. Partial progress still shows Ongoing/Not started regardless
// of broadcast status — this app is about your tracking, not the show's.
function tvStatusPill(show) {
  if (show.listType === 'stopped') return `<span class="pill">Stopped</span>`;
  const p = store.progress(show);
  if (p.aired === 0) return `<span class="pill pill--warn">Yet to release</span>`;
  if (p.watched >= p.aired) return store.isEnded(show) ? `<span class="pill">Ended</span>` : `<span class="pill pill--good">Caught up</span>`;
  if (show.listType === 'watching') return `<span class="pill pill--good">Ongoing</span>`;
  return `<span class="pill">Not started</span>`;
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
let welcomeNeeded = false; // computed at init; true until Google connect or skip

async function render() {
  if (welcomeNeeded) return renderWelcome();
  if (detailId != null) {
    if (isListId(detailId)) return renderListDetail(detailId);
    return isMovieId(detailId) ? renderMovieDetail(detailId) : renderTvDetail(detailId);
  }
  if (!api.hasKey()) return renderNeedKey();
  switch (route.sec) {
    case 'tv': return route.sub === 'calendar' ? renderTvCalendar() : renderTvUpNext();
    case 'movies': return route.sub === 'calendar' ? renderMovieCalendar() : renderMovieUpNext();
    case 'search': return renderSearch();
    case 'you':
      if (route.sub === 'all-tv') return renderFullList('tv');
      if (route.sub === 'all-movies') return renderFullList('movie');
      if (route.sub === 'all-lists') return renderAllLists();
      return renderYouHome();
  }
}

function renderWelcome() {
  view.innerHTML = `<div class="empty" style="padding-top:56px">
    <div class="empty__emoji">📺</div>
    <p class="empty__title" style="font-size:22px">Welcome to TV Time 2.0</p>
    <p>Your private TV &amp; movie tracker — no accounts, no social feed.</p>
    <p style="max-width:320px;margin:12px auto 0">Sign in with Google and TV Time 2.0 will save your watch
    data to <b>your own Google Drive</b>, so it follows you on every device.</p>
    <button class="btn btn--accent btn--block mt16" id="welcomeConnect" style="max-width:320px;margin-left:auto;margin-right:auto">Continue with Google</button>
    <button class="link" id="welcomeSkip" style="margin-top:16px;color:var(--muted2)">Use on this device only</button>
  </div>`;
  $('#welcomeConnect').onclick = () => sync.startLogin(); // full-page redirect to Google
  $('#welcomeSkip').onclick = async () => {
    welcomeNeeded = false;
    await db.setSetting('welcomeDone', true);
    render();
  };
}

function renderNeedKey() {
  view.innerHTML = empty('🔑', 'Add your TMDB key to start',
    'Tally pulls TV & movie data from The Movie Database (free).',
    '<button class="btn btn--accent mt16" id="openSettings">Open Settings</button>');
  $('#openSettings').onclick = openSettings;
}

// ---------- TV: Up Next ----------
function renderTvUpNext() {
  const watchNext = store.tvWatchNext();
  const yetToStart = store.tvYetToStart();
  const caught = store.tvCaughtUp();
  const yetToRelease = store.tvYetToRelease();
  const stopped = store.tvStopped();
  let html = segmented([{ sub: 'upnext', label: 'Watch Next' }, { sub: 'calendar', label: 'Future Releases' }]);
  if (!watchNext.length && !yetToStart.length && !caught.length && !yetToRelease.length && !stopped.length) {
    html += empty('🍿', 'No shows yet', 'Add a show from Search to start tracking.',
      '<button class="btn btn--accent mt16" data-goto="search">Find a show</button>');
  } else {
    if (watchNext.length) html += `<div class="section-title">Watch Next</div>` + watchNext.map(tvUpNextCard).join('');
    if (yetToStart.length) html += `<div class="section-title">Yet to Start</div>` + yetToStart.map(tvUpNextCard).join('');
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
    if (yetToRelease.length) html += `<div class="section-title">Yet to Release</div>` + yetToRelease.map((s) => `
      <div class="row" data-open="${s.id}">
        ${poster(s.poster)}
        <div class="row__body">
          <p class="row__title">${esc(s.name)}</p>
          <p class="row__sub">${s.firstAirDate ? 'Premieres ' + fmtDate(s.firstAirDate) : 'No air date yet'}</p>
        </div>
        ${countdownBadge(s.firstAirDate)}
      </div>`).join('');
    if (stopped.length) html += `<div class="section-title">Stopped</div>` + stopped.map((s) => {
      const p = store.progress(s);
      return `<div class="row" data-open="${s.id}">
        ${poster(s.poster)}
        <div class="row__body">
          <p class="row__title">${esc(s.name)}</p>
          <p class="row__sub">${p.watched}/${p.total} watched</p>
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
  let html = segmented([{ sub: 'upnext', label: 'Watch Next' }, { sub: 'calendar', label: 'Future Releases' }]);
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
  let html = segmented([{ sub: 'upnext', label: 'Watch Next' }, { sub: 'calendar', label: 'Future Releases' }]);
  const list = store.movieUpNext();
  if (!list.length) {
    html += empty('🎬', 'No movies queued', 'Add a movie from Search to build your watchlist.',
      '<button class="btn btn--accent mt16" data-goto="search">Find a movie</button>');
  } else {
    html += `<div class="section-title">To Watch</div>` + list.map((m) => {
      return `<div class="row" data-open="${m.id}">
        ${poster(m.poster, 'poster', '🎬')}
        <div class="row__body">
          <p class="row__title">${esc(m.name)}</p>
          <p class="row__sub">${(m.releaseDate || '').slice(0, 4) || '—'}${m.runtime ? ' · ' + m.runtime + 'm' : ''}</p>
        </div>
        <button class="ep__check" data-moviewatch="${m.id}" aria-label="Mark watched">✓</button>
      </div>`;
    }).join('');
  }
  view.innerHTML = html;
}

// ---------- Movies: Calendar ----------
function renderMovieCalendar() {
  let html = segmented([{ sub: 'upnext', label: 'Watch Next' }, { sub: 'calendar', label: 'Future Releases' }]);
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
  html += listsPreview();
  html += libPreview('tv', tv);
  html += libPreview('movie', mv);
  html += `<div class="section-title">Stats</div>` + statsHTML();
  view.innerHTML = html;
}

// ---------- You: Lists ----------
// A 2x2 poster collage from the list's first 4 items, standing in for a
// single cover image since a list is mixed-media with no poster of its own.
function listCollageHTML(items) {
  const cells = [0, 1, 2, 3].map((i) => {
    const it = items[i];
    return it && it.poster ? `<img src="${IMG.poster(it.poster, 'w185')}" alt="">` : `<div class="collage-ph">▦</div>`;
  }).join('');
  return `<div class="pcard__collage">${cells}</div>`;
}
function listCard(l) {
  const items = store.listItems(l.id);
  return `<div class="pcard" data-open="list:${l.id}">
    ${listCollageHTML(items)}
    <p class="pcard__title">${esc(l.name)}</p>
    <p class="pcard__meta">${items.length} item${items.length === 1 ? '' : 's'}</p>
  </div>`;
}
function listsPreview() {
  const lists = store.allLists();
  const head = `<div class="lib-head">
    <span class="lib-head__label">📋 Lists</span>
    ${lists.length ? `<button class="link" data-goto-list="lists">See all (${lists.length}) ›</button>` : ''}
  </div>`;
  if (!lists.length) {
    return head + `<div class="empty" style="padding:20px 16px">
      <p style="margin:0 0 10px">Group shows and movies into your own collections.</p>
      <button class="btn btn--accent" data-new-list>＋ Create your first list</button>
    </div>`;
  }
  return head + `<div class="hscroll">${lists.map(listCard).join('')}</div>`;
}
function renderAllLists() {
  const lists = store.allLists();
  let html = `<button class="back-btn" data-you-home>‹ Library</button>`;
  html += `<div class="lib-head" style="margin-top:0">
    <span class="lib-head__label">📋 All Lists · ${lists.length}</span>
    <button class="link" data-new-list>＋ New list</button>
  </div>`;
  html += lists.length
    ? `<div class="list-grid">${lists.map(listCard).join('')}</div>`
    : empty('📋', 'No lists yet', 'Create one to start grouping shows and movies.');
  view.innerHTML = html;
}

let listFilterFor = null, listFilter = 'all';
const FILTER_LABEL = { all: 'All', started: 'Started', watched: 'Watched', notstarted: 'Not Started' };
function renderListDetail(fullId) {
  const id = fullId.slice('list:'.length);
  const l = store.getList(id);
  if (!l) { detailId = null; route = { ...prev }; return render(); }
  if (listFilterFor !== id) { listFilterFor = id; listFilter = 'all'; }

  const allItems = store.listItems(id);
  const items = listFilter === 'all' ? allItems : allItems.filter((it) => store.itemWatchState(it) === listFilter);

  let html = `<button class="back-btn" data-back>‹ Back</button>`;
  html += `<div class="list-detail-head">
    ${listCollageHTML(allItems)}
    <div class="grow">
      <h2 class="detail-hero__title" style="margin-bottom:2px">${esc(l.name)}</h2>
      <p class="detail-hero__meta">${allItems.length} item${allItems.length === 1 ? '' : 's'}</p>
    </div>
  </div>`;
  html += `<div class="segmented" style="margin-top:14px">${Object.keys(FILTER_LABEL).map((f) =>
    `<button data-list-filter="${f}" class="${listFilter === f ? 'active' : ''}">${FILTER_LABEL[f]}</button>`).join('')}</div>`;

  html += items.length
    ? items.map((it) => it.mediaType === 'tv' ? tvLibRow(it, { listId: id }) : movieLibRow(it, { listId: id })).join('')
    : empty('📋', allItems.length ? 'Nothing in this filter' : 'This list is empty', 'Add shows or movies from their detail page.');

  html += `<div class="btn-row mt16">
    <button class="btn grow" data-rename-list="${id}">✎ Rename</button>
    <button class="btn btn--ghost" data-delete-list="${id}" style="color:var(--danger)">🗑 Delete</button>
  </div>`;
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
function listRemoveBtn(id, opts) {
  return opts?.listId ? `<button class="row__remove" data-list-remove="${opts.listId}::${id}" aria-label="Remove from list">✕</button>` : '';
}
function tvLibRow(s, opts) {
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
    ${listRemoveBtn(s.id, opts)}
  </div>`;
}
function movieLibRow(m, opts) {
  const rating = store.getRating(m.id);
  const upcoming = m.releaseDate && m.releaseDate > store.today();
  const pill = m.watchedAt ? { cls: 'pill--good', text: '✓ Watched' }
    : upcoming ? { cls: 'pill--warn', text: 'Yet to release' }
    : { cls: '', text: 'Yet to watch' };
  return `<div class="row" data-open="${m.id}">
    ${poster(m.poster, 'poster', '🎬')}
    <div class="row__body">
      <p class="row__title">${esc(m.name)}</p>
      <p class="row__sub">${(m.releaseDate || '').slice(0, 4) || '—'}${rating ? ` · <span class="rating-inline">${'★'.repeat(rating)}</span>` : ''}</p>
    </div>
    <span class="pill ${pill.cls}">${pill.text}</span>
    ${listRemoveBtn(m.id, opts)}
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

// IMDb rating on line one, your own rating on line two — only the lines that
// currently apply are shown (IMDb once fetched and non-empty; "My rating"
// only once you're actually eligible to rate it).
function ratingsBlock(item) {
  const rows = [];
  if (item.imdbRating != null) {
    rows.push(`<div class="ratings-row"><span class="ratings-label">IMDb</span><span class="ratings-value">${item.imdbRating.toFixed(1)}</span></div>`);
  }
  if (store.canRate(item)) {
    rows.push(`<div class="ratings-row"><span class="ratings-label">My rating</span>${starsHTML(item.id)}</div>`);
  }
  return rows.length ? `<div class="ratings-block">${rows.join('')}</div>` : '';
}

// Fetches an item's IMDb rating at most once (cached on the record), without
// blocking the rest of the detail page. Failures (offline, OMDb rate limit)
// are swallowed — imdbRating stays unset so the app tries again next visit,
// and the missing rating just never appears rather than showing an error.
async function ensureImdbRating(item) {
  if (item.imdbRating !== undefined) return;
  // A library item saved before this feature shipped has no imdbId field at
  // all (`undefined`) — distinct from a fresh fetch confirming there isn't
  // one (`null`, cached below). Backfill it once so old library items don't
  // silently stay ratingless forever.
  if (item.imdbId === undefined) {
    try { item.imdbId = await api.getImdbId(item.mediaType, item.tmdbId); }
    catch (_) { return; } // couldn't backfill yet; retried on next open
  }
  if (!item.imdbId) { item.imdbRating = null; }
  else {
    try { item.imdbRating = await api.getImdbRating(item.imdbId); }
    catch (_) { return; } // leave unset; retried on next open
  }
  if (store.inLibrary(item.id)) await store.cacheImdbRating(item.id, item.imdbRating);
  if (detailId === item.id) render();
}

// ---------- Detail: TV ----------
async function renderTvDetail(id) {
  let show = store.getItem(id) || tempItems.get(id);
  const saved = store.inLibrary(id);
  if (!show) {
    spinner();
    try { show = { ...(await api.getShowFull(Number(id.split(':')[1]))), id }; tempItems.set(id, show); }
    catch (err) { view.innerHTML = `<button class="back-btn" data-back>‹ Back</button>` + errorBox(err); const f = $('#fixKey'); if (f) f.onclick = openSettings; return; }
    if (detailId !== id) return;
  }
  ensureImdbRating(show);

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
      <div class="hstack" style="justify-content:flex-end"><span class="pill">${p.watched}/${p.aired || p.total} watched</span></div>
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
  if (saved) {
    if (show.listType === 'watchlist') {
      footer = `<div class="btn-row mt16">
        <button class="btn btn--accent grow" data-move="watching">Move to Watching</button>
        <button class="btn btn--ghost" data-remove style="color:var(--danger)">Remove</button></div>`;
    } else if (show.listType === 'stopped') {
      footer = `<div class="btn-row mt16">
        <button class="btn btn--accent grow" data-move="watching">▶ Resume watching</button>
        <button class="btn btn--ghost" data-remove style="color:var(--danger)">Remove</button></div>`;
    } else {
      footer = `<div class="btn-row mt16">
        <button class="btn grow" data-move="watchlist">Move to Watchlist</button>
        <button class="btn btn--ghost" data-remove style="color:var(--danger)">Remove</button></div>
        <div class="btn-row mt8">
        <button class="btn btn--ghost btn--block" data-move="stopped" style="color:var(--danger)">⏹ Stop watching</button></div>`;
    }
  }

  const addToListBtn = `<button class="btn btn--ghost btn--block mt8" data-add-to-list>📋 Add to List</button>`;
  view.innerHTML = heroHTML(show, meta, '▦') + ratingsBlock(show) + actions + addToListBtn + overview + `<div class="section-title">Episodes</div>` + seasons + footer;
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
    try { m = { ...(await api.getMovieFull(Number(id.split(':')[1]))), id }; tempItems.set(id, m); }
    catch (err) { view.innerHTML = `<button class="back-btn" data-back>‹ Back</button>` + errorBox(err); const f = $('#fixKey'); if (f) f.onclick = openSettings; return; }
    if (detailId !== id) return;
  }
  ensureImdbRating(m);

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
    actions = `<button class="btn ${m.watchedAt ? '' : 'btn--good'} btn--block mt16" data-moviewatch="${id}">
        ${m.watchedAt ? 'Mark as unwatched' : '✓ Mark watched'}</button>
      <div class="btn-row mt8"><button class="btn btn--ghost btn--block" data-remove style="color:var(--danger)">Remove</button></div>`;
  }
  const overview = m.overview ? `<p class="muted mt16" style="font-size:14px;line-height:1.5">${esc(m.overview)}</p>` : '';
  const addToListBtn = `<button class="btn btn--ghost btn--block mt8" data-add-to-list>📋 Add to List</button>`;
  view.innerHTML = heroHTML(m, meta, '🎬') + ratingsBlock(m) + actions + addToListBtn + overview;
}

// ---------- Add to List sheet ----------
function openAddToListSheet(itemId) {
  const rec = tempItems.get(itemId) || store.getItem(itemId);
  if (!rec) return;
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  const renderSheet = () => {
    const lists = store.allLists();
    const memberOf = new Set(store.listsContaining(itemId).map((l) => l.id));
    wrap.innerHTML = `<div class="modal">
      <div class="modal__handle"></div>
      <h2>Add to List</h2>
      <div class="list-check-rows">
        <button class="list-check-row" id="newListRow"><span class="list-check-row__plus">＋</span><span>New list</span></button>
        ${lists.map((l) => `<label class="list-check-row">
          <input type="checkbox" data-list-id="${l.id}" ${memberOf.has(l.id) ? 'checked' : ''}>
          <span class="grow">${esc(l.name)}</span><span class="muted" style="font-size:12px">${l.itemIds.length}</span>
        </label>`).join('')}
        ${!lists.length ? '<p class="muted" style="font-size:13px">No lists yet — create one above.</p>' : ''}
      </div>
      <div class="btn-row mt16"><button class="btn btn--ghost btn--block" id="closeListSheet">Done</button></div>
    </div>`;
    wrap.querySelector('#closeListSheet').onclick = close;
    wrap.querySelector('#newListRow').onclick = async () => {
      const name = prompt('List name');
      if (!name || !name.trim()) return;
      const list = await store.createList(name);
      if (!store.inLibrary(itemId)) await store.addItem(rec, 'watchlist');
      await store.addToList(list.id, itemId);
      toast('List created');
      renderSheet();
    };
    wrap.querySelectorAll('input[data-list-id]').forEach((cb) => {
      cb.onchange = async () => {
        const listId = cb.dataset.listId;
        if (cb.checked) {
          if (!store.inLibrary(itemId)) await store.addItem(rec, 'watchlist');
          await store.addToList(listId, itemId);
        } else {
          await store.removeFromList(listId, itemId);
        }
      };
    });
  };
  const close = () => { wrap.remove(); render(); };
  document.body.appendChild(wrap);
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
  renderSheet();
}

// ---------- click handling ----------
document.addEventListener('click', async (ev) => {
  const t = ev.target;

  if (t.id === 'fixKey' || t.id === 'openSettings') return openSettings();

  const gotoEl = t.closest('[data-goto]');
  if (gotoEl) return go(gotoEl.dataset.goto);

  // Open the full list for a media type (from the You/Library preview)
  const listEl = t.closest('[data-goto-list]');
  if (listEl) {
    const kind = listEl.dataset.gotoList;
    route = { sec: 'you', sub: kind === 'tv' ? 'all-tv' : kind === 'movie' ? 'all-movies' : 'all-lists' };
    window.scrollTo(0, 0); return render();
  }

  // Back from a full list to the Library home
  if (t.closest('[data-you-home]')) { route = { sec: 'you', sub: 'home' }; syncTabs(); window.scrollTo(0, 0); return render(); }

  // Create a new list (from the You/Library empty state, "See all" header, or the Add-to-List sheet)
  if (t.closest('[data-new-list]')) {
    const name = prompt('List name');
    if (name && name.trim()) {
      const list = await store.createList(name);
      toast('List created');
      return openDetail('list:' + list.id);
    }
    return;
  }

  // Filter chips within a list's detail page
  const filterEl = t.closest('[data-list-filter]');
  if (filterEl) { listFilter = filterEl.dataset.listFilter; return render(); }

  if (t.closest('[data-rename-list]')) {
    const id = t.closest('[data-rename-list]').dataset.renameList;
    const l = store.getList(id); if (!l) return;
    const name = prompt('Rename list', l.name);
    if (name && name.trim()) { await store.renameList(id, name); toast('Renamed'); render(); }
    return;
  }

  if (t.closest('[data-delete-list]')) {
    const id = t.closest('[data-delete-list]').dataset.deleteList;
    if (confirm('Delete this list? Items stay in your library.')) {
      await store.deleteList(id);
      detailId = null; route = { sec: 'you', sub: 'home' }; syncTabs(); toast('List deleted'); render();
    }
    return;
  }

  // Remove a single item from within a list's own view (never untracks it)
  const listRemoveEl = t.closest('[data-list-remove]');
  if (listRemoveEl) {
    ev.stopPropagation();
    const [listId, itemId] = listRemoveEl.dataset.listRemove.split('::');
    await store.removeFromList(listId, itemId);
    toast('Removed from list');
    return render();
  }

  // Open the "Add to List" sheet from a TV/movie detail page
  if (t.closest('[data-add-to-list]')) { openAddToListSheet(detailId); return; }

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

// ---------- Google Drive box (inside Settings) ----------
let activeSettings = null;

function updateSyncBanner() {
  const b = document.getElementById('syncBanner');
  if (!b) return;
  const st = sync.status();
  b.hidden = st.connected || !st.needsReconnect; // never show while connected
}

async function renderGdriveBox(wrap) {
  const box = wrap.querySelector('#gdriveBox');
  if (!box) return;
  const st = sync.status();
  const wasEnabled = await db.getSetting('gdriveEnabled', false);

  if (!st.connected) {
    box.innerHTML = `
      <p style="margin-top:0"><b>Sign in with Google to sync across devices.</b> Your watch data is
      saved to a private app folder in <b>your own Google Drive</b> — nothing else in your Drive is
      visible to this app. Sign in once and you stay connected.</p>
      <div class="btn-row"><button class="btn btn--accent grow" id="gConnect">${wasEnabled ? '↻ Reconnect Google Drive' : 'Sign in with Google'}</button></div>`;
    box.querySelector('#gConnect').onclick = () => sync.startLogin();
    return;
  }

  const stale = !st.syncing && await sync.checkStale();
  const lastSyncText = st.syncing ? '<i>syncing…</i>'
    : st.lastSyncAt ? `last sync ${lastSyncLabel(st.lastSyncAt)}`
    : 'not yet synced';
  box.innerHTML = `
    <p style="margin-top:0">✓ Signed in as <b>${esc(st.email || 'your account')}</b> · ${lastSyncText}</p>
    ${stale ? `<p style="color:var(--warn)">⚠️ Some changes on this device haven't backed up in a few days — check your connection and try syncing now.</p>` : ''}
    <div class="btn-row">
      <button class="btn grow" id="gSyncNow">Sync now</button>
      <button class="btn btn--ghost" id="gDisconnect" style="color:var(--danger)">Disconnect</button>
    </div>`;
  box.querySelector('#gSyncNow').onclick = async () => {
    try { await sync.syncNow(); toast('Synced'); } catch (_) { toast('Sync failed — check connection'); }
    renderGdriveBox(wrap);
  };
  box.querySelector('#gDisconnect').onclick = async () => {
    await sync.disconnect(); toast('Google Drive disconnected'); renderGdriveBox(wrap);
  };
}

// ---------- Backup (CSV) ----------
// A real spreadsheet, not a JSON blob nobody would hand-edit. One row per
// watched episode (plus one row for any show with nothing watched yet, so it
// still round-trips), and one row per movie. Re-importing re-fetches full
// show/episode details from TMDB using the stored ID — the CSV only needs to
// carry the identifiers and your watched/rating state.
function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
const csvRow = (fields) => fields.map(csvEscape).join(',');

async function buildCsv() {
  const watchedAt = new Map((await db.getAll('watched')).map((w) => [w.key, w.at]));
  const lines = [csvRow(['Type', 'Title', 'TMDB ID', 'List', 'Season', 'Episode', 'Watched On', 'Rating'])];

  for (const s of store.tvShows()) {
    const rating = store.getRating(s.id) || '';
    let any = false;
    for (const season of s.seasons || []) {
      for (const ep of season.episodes) {
        if (store.isWatched(s.id, season.season_number, ep.episode_number)) {
          any = true;
          const at = (watchedAt.get(store.epKey(s.id, season.season_number, ep.episode_number)) || '').slice(0, 10);
          lines.push(csvRow(['TV', s.name, s.tmdbId, s.listType, season.season_number, ep.episode_number, at, rating]));
        }
      }
    }
    if (!any) lines.push(csvRow(['TV', s.name, s.tmdbId, s.listType, '', '', '', rating]));
  }
  for (const m of store.movies()) {
    const rating = store.getRating(m.id) || '';
    lines.push(csvRow(['Movie', m.name, m.tmdbId, m.watchedAt ? 'watched' : 'towatch', '', '', (m.watchedAt || '').slice(0, 10), rating]));
  }
  return lines.join('\r\n');
}

// Minimal RFC4180-ish CSV parser: handles quoted fields with embedded commas,
// quotes ("" escaping) and newlines.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function importCsv(text) {
  const rows = parseCsv(text);
  if (!rows.length) throw new Error('empty');
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name) => header.indexOf(name);
  const iType = col('type'), iTitle = col('title'), iId = col('tmdb id'), iList = col('list'),
        iSeason = col('season'), iEpisode = col('episode'), iWatched = col('watched on'), iRating = col('rating');
  if (iType < 0 || iId < 0) throw new Error('bad_header');

  // ISO date-only string -> a stable timestamp for that day (noon, to avoid
  // timezone edge cases shifting it to the previous/next day).
  const toAt = (d) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d.trim())) ? `${d.trim()}T12:00:00.000Z` : null;

  const groups = new Map();
  for (const r of rows.slice(1)) {
    if (!r[iType] || !r[iId]) continue;
    const type = r[iType].trim().toLowerCase();
    const key = type + ':' + r[iId].trim();
    if (!groups.has(key)) groups.set(key, { type, tmdbId: Number(r[iId]), title: r[iTitle], list: '', rating: 0, watchedAt: null, episodes: [] });
    const g = groups.get(key);
    if (r[iList]) g.list = r[iList].trim().toLowerCase();
    if (iRating >= 0 && r[iRating]) g.rating = Number(r[iRating]) || g.rating;
    const at = iWatched >= 0 ? toAt(r[iWatched]) : null;
    if (at) g.watchedAt = at; // movies: the row's own date
    if (iSeason >= 0 && iEpisode >= 0 && r[iSeason] && r[iEpisode]) g.episodes.push([Number(r[iSeason]), Number(r[iEpisode]), at]);
  }

  let ok = 0, failed = 0;
  for (const g of groups.values()) {
    try {
      if (g.type === 'tv') {
        const full = await api.getShowFull(g.tmdbId);
        const rec = await store.addItem(full, g.list === 'watching' ? 'watching' : 'watchlist');
        for (const [s, e, at] of g.episodes) await store.toggleWatched(rec.id, s, e, true, at);
        if (g.rating) await store.setRating(rec.id, g.rating);
      } else if (g.type === 'movie') {
        const full = await api.getMovieFull(g.tmdbId);
        const rec = await store.addItem(full, 'watchlist');
        if (g.list === 'watched') await store.toggleMovieWatched(rec.id, true, g.watchedAt);
        if (g.rating) await store.setRating(rec.id, g.rating);
      } else continue;
      ok++;
    } catch (_) { failed++; }
  }
  return { ok, failed, total: groups.size };
}

// ---------- Backup history (Google Drive revisions) ----------
// Drive automatically keeps prior versions of the backup file each time it's
// overwritten — a real recovery path independent of anything this app itself
// tracks, for when a bad sync ever leaves the current data looking wrong.
function openBackupHistory() {
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });

  const renderList = async () => {
    wrap.innerHTML = `<div class="modal">
      <div class="modal__handle"></div>
      <h2>Backup History</h2>
      <div id="revList"><div class="spinner" style="margin:10px auto"></div></div>
      <div class="btn-row mt16"><button class="btn btn--ghost btn--block" id="closeHistory">Close</button></div>
    </div>`;
    wrap.querySelector('#closeHistory').onclick = close;
    const box = wrap.querySelector('#revList');
    if (!sync.status().connected) {
      box.innerHTML = `<p class="muted">Sign in to Google Drive above to view backup history.</p>`;
      return;
    }
    try {
      const revisions = await sync.listRevisions();
      if (!revisions.length) { box.innerHTML = `<p class="muted">No backup history yet — nothing has synced to Google Drive.</p>`; return; }
      box.innerHTML = revisions.map((r, i) => `<button class="list-check-row" data-rev="${r.id}">
        <span class="grow">${new Date(r.modifiedTime).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</span>
        ${i === 0 ? '<span class="pill pill--good">Latest</span>' : ''}
      </button>`).join('');
      revisions.forEach((r) => {
        wrap.querySelector(`[data-rev="${r.id}"]`).onclick = () => renderPreview(r.id, new Date(r.modifiedTime));
      });
    } catch (_) {
      box.innerHTML = `<p class="muted">Couldn't load backup history — check your connection.</p>`;
    }
  };

  const renderPreview = async (revisionId, modifiedTime) => {
    wrap.innerHTML = `<div class="modal">
      <div class="modal__handle"></div>
      <h2>Restore Backup</h2>
      <div id="revPreview"><div class="spinner" style="margin:10px auto"></div></div>
      <div class="btn-row mt16"><button class="btn btn--ghost btn--block" id="backToList">‹ Back</button></div>
    </div>`;
    wrap.querySelector('#backToList').onclick = renderList;
    const box = wrap.querySelector('#revPreview');
    try {
      const payload = await sync.getRevision(revisionId);
      const d = payload.data || {};
      box.innerHTML = `
        <p class="muted" style="font-size:13px;margin-top:0">${modifiedTime.toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' })}</p>
        <div class="stat-grid mt8">
          <div class="stat"><div class="stat__num stat__num--accent">${(d.shows || []).length}</div><div class="stat__label">Shows/Movies</div></div>
          <div class="stat"><div class="stat__num stat__num--good">${(d.watched || []).length}</div><div class="stat__label">Watched eps</div></div>
          <div class="stat"><div class="stat__num">${(d.lists || []).length}</div><div class="stat__label">Lists</div></div>
        </div>
        <button class="btn btn--accent btn--block mt16" id="doRestore">Restore this backup</button>`;
      box.querySelector('#doRestore').onclick = async () => {
        if (!confirm('Restore this backup? This replaces everything currently on this device — and in Google Drive — with this older version.')) return;
        try {
          await sync.restoreRevision(payload);
          await store.loadState();
          close();
          if (activeSettings) { activeSettings.remove(); activeSettings = null; }
          toast('Backup restored');
          render();
        } catch (_) { toast('Restore failed — check your connection'); }
      };
    } catch (_) {
      box.innerHTML = `<p class="muted">Couldn't load this backup — check your connection.</p>`;
    }
  };

  renderList();
}

// ---------- Settings modal ----------
function openSettings() {
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  wrap.innerHTML = `
    <div class="modal">
      <div class="modal__handle"></div>
      <h2>Settings</h2>
      <label>Google Drive sync</label>
      <div id="gdriveBox"><div class="spinner" style="margin:10px auto"></div></div>
      <p class="muted" style="font-size:12px;margin-top:8px">If you sign in with Google, your email and basic usage counts (how many shows/movies you've saved — never titles or watch history) are visible to the developer to help improve the app.</p>
      <label>Backup history</label>
      <div class="btn-row"><button class="btn btn--block" id="openBackupHistory">View past backups from Google Drive</button></div>
      <p class="muted" style="font-size:12px;margin-top:8px">Google Drive keeps earlier versions of your synced backup — useful if something ever looks wrong after a sync and you want to restore an older, known-good version.</p>
      <label>Backup</label>
      <div class="btn-row">
        <button class="btn grow" id="exportBtn">Export CSV</button>
        <button class="btn grow" id="importBtn">Import CSV</button>
        <input id="importFile" type="file" accept=".csv,text/csv" hidden>
      </div>
      <p class="muted" style="font-size:12px;margin-top:8px">A spreadsheet of your shows, movies, episodes watched, and ratings — opens in Excel, Numbers, or Google Sheets. Importing a previously exported file re-fetches show details, so it needs internet and may take a few seconds.</p>
      <label>Install on iPhone</label>
      <p>Open this page in <b>Safari</b> → tap <b>Share</b> → <b>Add to Home Screen</b>. TV Time 2.0 then opens fullscreen like a native app.</p>
      <div class="btn-row mt16"><button class="btn btn--ghost btn--block" id="closeSettings">Close</button></div>
      <p class="center muted" style="font-size:12px;margin-top:14px">TV Time 2.0 · a private, social-free TV & movie tracker</p>
    </div>`;
  document.body.appendChild(wrap);
  activeSettings = wrap;
  renderGdriveBox(wrap);
  const close = () => { activeSettings = null; wrap.remove(); };
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
  wrap.querySelector('#closeSettings').onclick = close;
  wrap.querySelector('#openBackupHistory').onclick = () => openBackupHistory();
  wrap.querySelector('#exportBtn').onclick = async () => {
    const blob = new Blob([await buildCsv()], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `tvtime2-backup-${new Date().toISOString().slice(0, 10)}.csv`; a.click(); URL.revokeObjectURL(a.href);
  };
  wrap.querySelector('#importBtn').onclick = () => wrap.querySelector('#importFile').click();
  wrap.querySelector('#importFile').onchange = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    const btn = wrap.querySelector('#importBtn');
    const original = btn.textContent;
    btn.disabled = true; btn.textContent = 'Importing…';
    try {
      const { ok, failed, total } = await importCsv(await file.text());
      await store.loadState();
      toast(failed ? `Imported ${ok}/${total} (${failed} failed)` : `Imported ${ok} item${ok === 1 ? '' : 's'}`);
      close(); render();
    } catch (_) {
      toast('Import failed — check the CSV format');
    } finally {
      btn.disabled = false; btn.textContent = original;
    }
  };
}

// ---------- init ----------
async function init() {
  // Ask the browser not to evict this site's local data under storage
  // pressure — this is the only local copy of a user's tracking data
  // between syncs, and getting silently wiped is a real, documented browser
  // behavior (e.g. Safari's inactivity-based storage eviction).
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  document.querySelectorAll('.tab').forEach((b) => (b.onclick = () => go(b.dataset.sec)));
  $('#settingsBtn').onclick = openSettings;
  $('#brand').onclick = () => go('tv');
  await store.loadState();
  welcomeNeeded = !(await db.getSetting('welcomeDone', false)) && !(await db.getSetting('gdriveEnabled', false));
  syncTabs(); render();

  // Persistent one-tap reconnect banner (shown only when Drive needs it).
  const banner = document.createElement('div');
  banner.id = 'syncBanner';
  banner.className = 'sync-banner';
  banner.hidden = true;
  banner.innerHTML = `<span>☁️ Google Drive needs reconnect</span><button class="btn btn--sm btn--accent" id="bannerReconnect">Reconnect</button>`;
  document.body.appendChild(banner);
  banner.querySelector('#bannerReconnect').onclick = () => sync.startLogin();

  // If we just came back from Google, tidy the URL (?auth=ok / denied / fail).
  const authParam = new URLSearchParams(location.search).get('auth');
  if (authParam) {
    history.replaceState(null, '', location.pathname);
    if (authParam === 'denied' || authParam === 'fail') toast('Google sign-in didn’t complete');
  }

  // Google Drive sync (via backend): fetch a fresh token, live status.
  sync.init({
    onRemoteApplied: async () => {
      await store.loadState(); render();
      toast('Updated from Google Drive');
    },
    onStatusChange: () => {
      updateSyncBanner();
      if (sync.status().connected && welcomeNeeded) { welcomeNeeded = false; render(); }
      if (activeSettings) renderGdriveBox(activeSettings);
    }
  }).catch(() => {});

  if ('serviceWorker' in navigator) { try { await navigator.serviceWorker.register('./sw.js'); } catch (_) {} }
}
init();
