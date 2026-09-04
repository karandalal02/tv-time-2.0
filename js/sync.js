// Google Drive sync via our own backend (see /api/auth/*).
//
//  - Sign in ONCE: a full-page redirect to /api/auth/login → Google → back.
//    The backend keeps the refresh token in a first-party cookie.
//  - Every open, we ask /api/auth/token for a fresh access token. Because it's
//    same-origin, this works silently on mobile Firefox/Safari — the whole
//    reason we moved to a backend. No popups, no third-party cookies.
//  - Drive files are still read/written directly from the browser with that
//    access token (Google allows CORS for the Drive API).
//  - Conflict rule: newest change wins (a local 'lastChangeAt' vs the Drive file).
import { db } from './db.js';

const FILE_NAME = 'tvtime2-data.json';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

let accessToken = null;
let tokenExpiresAt = 0;
let fileId = null;
let email = null;
let lastSyncAt = null;
let syncing = false;
let needsReconnect = false;
let pushTimer = null;
let cbs = {}; // { onRemoteApplied, onStatusChange }

export function status() {
  return { connected: !!accessToken && Date.now() < tokenExpiresAt, needsReconnect, email, lastSyncAt, syncing };
}

// ---------- token (from our backend) ----------
async function fetchBackendToken() {
  let res;
  try { res = await fetch('/api/auth/token', { credentials: 'include', cache: 'no-store' }); }
  catch (_) { return null; }              // offline / backend unavailable (e.g. local preview)
  if (res.status === 401) return 'UNAUTH'; // signed out — needs reconnect
  if (!res.ok) return null;
  return res.json();                       // { access_token, expires_in, email }
}

// Ensure we hold a valid access token. Returns true/false, or 'UNAUTH' when the
// backend says the user must reconnect.
async function ensureToken() {
  if (accessToken && Date.now() < tokenExpiresAt) return true;
  const t = await fetchBackendToken();
  if (t === 'UNAUTH') { accessToken = null; return 'UNAUTH'; }
  if (!t || !t.access_token) { accessToken = null; return false; }
  accessToken = t.access_token;
  tokenExpiresAt = Date.now() + Math.max(0, (t.expires_in || 3600) - 120) * 1000;
  if (t.email) { email = t.email; await db.setSetting('gdriveEmail', email); }
  return true;
}

async function authedFetch(url, opts = {}) {
  const ok = await ensureToken();
  if (ok !== true) { needsReconnect = (ok === 'UNAUTH'); cbs.onStatusChange?.(); throw new Error('NEEDS_RECONNECT'); }
  const doFetch = () => fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${accessToken}` } });
  let res = await doFetch();
  if (res.status === 401) {
    accessToken = null; tokenExpiresAt = 0;
    const again = await ensureToken();
    if (again !== true) { needsReconnect = (again === 'UNAUTH'); cbs.onStatusChange?.(); throw new Error('NEEDS_RECONNECT'); }
    res = await doFetch();
  }
  if (!res.ok) throw new Error('DRIVE_HTTP_' + res.status);
  return res;
}

// ---------- Drive file ops (app-data folder) ----------
async function findFile() {
  const q = encodeURIComponent(`name='${FILE_NAME}'`);
  const res = await authedFetch(`${API}/files?spaces=appDataFolder&q=${q}&fields=files(id)`);
  return (await res.json()).files?.[0]?.id || null;
}
async function downloadFile(id) { return (await authedFetch(`${API}/files/${id}?alt=media`)).json(); }
async function uploadFile(payload) {
  const body = JSON.stringify(payload);
  if (fileId) {
    await authedFetch(`${UPLOAD}/files/${fileId}?uploadType=media`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body
    });
  } else {
    const meta = { name: FILE_NAME, parents: ['appDataFolder'] };
    const boundary = 'tvtime2sync';
    const multipart =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
    const res = await authedFetch(`${UPLOAD}/files?uploadType=multipart`, {
      method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: multipart
    });
    fileId = (await res.json()).id;
  }
}

// Google Drive automatically keeps prior versions of a file each time it's
// overwritten in place (which is exactly what uploadFile's PATCH does) — a
// real recovery path if a bad sync ever overwrites today's backup with
// something stale, independent of anything this app itself tracks locally.
export async function listRevisions() {
  if (fileId == null) fileId = await findFile();
  if (!fileId) return [];
  const res = await authedFetch(`${API}/files/${fileId}/revisions?fields=revisions(id,modifiedTime,size)&pageSize=1000`);
  const data = await res.json();
  return (data.revisions || []).sort((a, b) => new Date(b.modifiedTime) - new Date(a.modifiedTime));
}
export async function getRevision(revisionId) {
  if (fileId == null) fileId = await findFile();
  return (await authedFetch(`${API}/files/${fileId}/revisions/${revisionId}?alt=media`)).json();
}

// Persisted (not just in-memory) so a fresh page load still knows how long
// it's actually been since sync last genuinely succeeded — the in-memory
// lastSyncAt alone would reset to "unknown" on every reload, which can't
// tell a healthy quiet period apart from days of silently failing pushes.
async function markSynced() {
  lastSyncAt = new Date();
  await db.setSetting('lastSyncSuccessAt', lastSyncAt.getTime());
}

// ---------- core sync ----------
async function push() {
  const exported = await db.exportAll();
  await uploadFile({
    app: 'tvtime2', version: 2,
    savedAt: new Date().toISOString(),
    lastChangeAt: await db.getSetting('lastChangeAt', 0),
    data: exported
  });
  await markSynced();
  reportUsage(exported.shows); // fire-and-forget; aggregate counts only
}

// Tells the backend how many shows/movies this account has saved — counts
// only, never titles or watch history. Best-effort: a failure here (offline,
// backend down, etc.) must never affect Drive sync.
function reportUsage(shows) {
  const showCount = (shows || []).filter((s) => s.mediaType === 'tv').length;
  const movieCount = (shows || []).filter((s) => s.mediaType === 'movie').length;
  fetch('/api/usage/report', {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ shows: showCount, movies: movieCount })
  }).catch(() => {});
}
// Also report right after confirming a connection (not just after a data
// change) — so simply opening the app while signed in is enough to appear in
// the roster, with no dependency on change timing.
async function reportUsageNow() {
  try { reportUsage((await db.exportAll()).shows); } catch (_) {}
}
async function applyRemote(remote) {
  db.setSuppressChanges(true);
  try {
    await db.replaceAll(remote.data || {});
    await db.setSetting('lastChangeAt', remote.lastChangeAt || 0);
  } finally { db.setSuppressChanges(false); }
  await markSynced();
  if (cbs.onRemoteApplied) await cbs.onRemoteApplied();
}

// An explicit, user-chosen restore from an older Drive revision (see
// listRevisions/getRevision). Unlike applyRemote, this is a deliberate
// correction, not a routine reconciliation — it stamps a fresh lastChangeAt
// and pushes immediately, so the restored data becomes the authoritative
// version both locally and on Drive right away rather than waiting for the
// next normal sync to decide who wins.
export async function restoreRevision(payload) {
  db.setSuppressChanges(true);
  try { await db.replaceAll(payload.data || {}); }
  finally { db.setSuppressChanges(false); }
  await db.setSetting('lastChangeAt', Date.now());
  if (cbs.onRemoteApplied) await cbs.onRemoteApplied();
  await push();
}

// The lastChangeAt clock alone isn't a safe enough signal to trust for
// something as destructive as replacing all local data — it lives in the
// same local storage that can get wiped (e.g. browser storage eviction),
// which resets it to look "older" than a Drive backup that's actually
// stale. So a remote that would *shrink* an already-populated device (fewer
// shows, fewer watched episodes, fewer lists) is treated as suspect rather
// than trusted blindly — except when local is genuinely empty, which is the
// normal, desired case of a fresh device pulling its real backup for the
// first time.
function isRegressive(localData, remoteData) {
  const hasLocalData = (localData.shows || []).length || (localData.watched || []).length || (localData.lists || []).length;
  if (!hasLocalData) return false;
  return (remoteData.shows || []).length < (localData.shows || []).length
    || (remoteData.watched || []).length < (localData.watched || []).length
    || (remoteData.lists || []).length < (localData.lists || []).length;
}

export async function syncNow() {
  if (syncing) return;
  syncing = true; cbs.onStatusChange?.();
  try {
    if (fileId == null) fileId = await findFile();
    const localLC = await db.getSetting('lastChangeAt', 0);
    if (!fileId) { await push(); return; }
    const remote = await downloadFile(fileId);
    const remoteLC = remote?.lastChangeAt || 0;
    if (remoteLC > localLC) {
      const localData = await db.exportAll();
      if (isRegressive(localData, remote.data || {})) {
        // Local wins this correction — stamp it as a fresh change rather
        // than pushing with the old (lower) local clock value, which would
        // otherwise leave Drive's lastChangeAt looking older than it was.
        await db.setSetting('lastChangeAt', Date.now());
        await push();
      } else await applyRemote(remote);
    }
    else if (localLC > remoteLC) await push();
    else await markSynced();
  } finally { syncing = false; cbs.onStatusChange?.(); }
}

// True when there are local changes that haven't successfully reached Drive
// in a while — distinct from needsReconnect (an auth failure the user must
// act on): this covers any other silent failure (network, Drive API errors,
// etc.) that the existing debounced push() swallows without surfacing.
const STALE_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
export async function checkStale() {
  const lastChangeAt = await db.getSetting('lastChangeAt', 0);
  const lastSyncSuccessAt = await db.getSetting('lastSyncSuccessAt', 0);
  if (!lastChangeAt || lastChangeAt <= lastSyncSuccessAt) return false; // nothing unsynced
  return (Date.now() - lastSyncSuccessAt) > STALE_MS;
}

function schedulePush() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    syncNow().catch(() => {}); // offline / needs-reconnect; retried on next change
  }, 2500);
}

// ---------- public actions ----------
// Full-page redirect to begin (or renew) sign-in. Returns nothing — the page
// navigates away and comes back authenticated.
export function startLogin() { window.location.assign('/api/auth/login'); }

export async function disconnect() {
  try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }); } catch (_) {}
  accessToken = null; tokenExpiresAt = 0; email = null; fileId = null; needsReconnect = false;
  await db.setSetting('gdriveEnabled', false);
  await db.setSetting('gdriveEmail', null);
  cbs.onStatusChange?.();
}

export async function init(callbacks) {
  cbs = callbacks || {};
  email = await db.getSetting('gdriveEmail', null); // last-known email (shown while (re)connecting)
  const persistedSyncAt = await db.getSetting('lastSyncSuccessAt', null);
  if (persistedSyncAt) lastSyncAt = new Date(persistedSyncAt);
  db.onDataChange(() => { if (accessToken) schedulePush(); });

  const ok = await ensureToken();
  if (ok === true) {
    needsReconnect = false;
    await db.setSetting('gdriveEnabled', true);
    await db.setSetting('welcomeDone', true); // being signed in completes onboarding
    cbs.onStatusChange?.();
    syncNow().catch(() => {});
    reportUsageNow();
  } else if (ok === 'UNAUTH' && await db.getSetting('gdriveEnabled', false)) {
    needsReconnect = true; // was connected before; refresh token gone → one tap to reconnect
    cbs.onStatusChange?.();
  }
  // ok === false → backend unavailable (e.g. local preview); stay local-only, no banner.
}
