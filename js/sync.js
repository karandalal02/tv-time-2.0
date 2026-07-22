// Google Drive sync. Design:
//  - Explicit consent: user taps "Connect Google Drive" and approves via
//    Google's own screen; we display exactly which email is connected.
//  - Data lives in a single JSON file in the Drive *app-data folder* — a
//    hidden, app-private area of the user's own Drive (no clutter, and this
//    app can't see any other Drive files: scope is drive.appdata only).
//  - Silent reconnect: while the user stays signed in to Google in this
//    browser, we refresh access in the background — no repeated logins.
//  - Conflict rule: newest change wins. A local change clock ('lastChangeAt')
//    is compared with the one stored in the Drive file.
import { db } from './db.js';
import { GOOGLE_CLIENT_ID } from './config.js';

const SCOPES = 'https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/userinfo.email';
const FILE_NAME = 'tvtime2-data.json';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

let tokenClient = null;
let accessToken = null;
let tokenExpiresAt = 0;
let fileId = null;
let email = null;
let lastSyncAt = null;
let syncing = false;
let pushTimer = null;
let cbs = {}; // { onRemoteApplied, onStatusChange }

// ---------- public status ----------
export async function getClientId() {
  return GOOGLE_CLIENT_ID || await db.getSetting('gClientId', '');
}
export async function setClientId(v) { await db.setSetting('gClientId', (v || '').trim()); }
export function status() {
  return { connected: !!accessToken, email, lastSyncAt, syncing };
}

// ---------- Google Identity Services ----------
function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load Google sign-in (offline?)'));
    document.head.appendChild(s);
  });
}

async function ensureTokenClient() {
  const clientId = await getClientId();
  if (!clientId) throw new Error('NO_CLIENT_ID');
  await loadGis();
  if (!tokenClient) {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPES,
      callback: () => {} // replaced per-request
    });
  }
  return tokenClient;
}

// prompt '' → Google shows UI only if needed; 'none' → silent or fail.
function requestToken(prompt) {
  return new Promise((resolve, reject) => {
    tokenClient.callback = (resp) => resp.error ? reject(new Error(resp.error)) : resolve(resp);
    tokenClient.error_callback = (err) => reject(new Error(err?.type || 'auth_failed'));
    tokenClient.requestAccessToken({ prompt });
  });
}

async function acquireToken(interactive) {
  await ensureTokenClient();
  const resp = await requestToken(interactive ? '' : 'none');
  accessToken = resp.access_token;
  tokenExpiresAt = Date.now() + Math.max(0, (resp.expires_in - 120)) * 1000;
}

async function authedFetch(url, opts = {}) {
  if (!accessToken || Date.now() > tokenExpiresAt) await acquireToken(false);
  const doFetch = () => fetch(url, {
    ...opts,
    headers: { ...(opts.headers || {}), Authorization: `Bearer ${accessToken}` }
  });
  let res = await doFetch();
  if (res.status === 401) { await acquireToken(false); res = await doFetch(); }
  if (!res.ok) throw new Error('DRIVE_HTTP_' + res.status);
  return res;
}

// ---------- Drive file ops (app-data folder) ----------
async function findFile() {
  const q = encodeURIComponent(`name='${FILE_NAME}'`);
  const res = await authedFetch(`${API}/files?spaces=appDataFolder&q=${q}&fields=files(id,modifiedTime)`);
  const data = await res.json();
  return data.files?.[0]?.id || null;
}
async function downloadFile(id) {
  const res = await authedFetch(`${API}/files/${id}?alt=media`);
  return res.json();
}
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
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body: multipart
    });
    fileId = (await res.json()).id;
  }
}

// ---------- core sync ----------
async function fetchEmail() {
  const res = await authedFetch('https://www.googleapis.com/oauth2/v3/userinfo');
  const info = await res.json();
  email = info.email || null;
  if (email) await db.setSetting('gdriveEmail', email);
}

async function push() {
  const payload = {
    app: 'tvtime2', version: 2,
    savedAt: new Date().toISOString(),
    lastChangeAt: await db.getSetting('lastChangeAt', 0),
    data: await db.exportAll()
  };
  await uploadFile(payload);
  lastSyncAt = new Date();
}

async function applyRemote(remote) {
  db.setSuppressChanges(true);
  try {
    await db.replaceAll(remote.data || {});
    await db.setSetting('lastChangeAt', remote.lastChangeAt || 0);
  } finally { db.setSuppressChanges(false); }
  lastSyncAt = new Date();
  if (cbs.onRemoteApplied) await cbs.onRemoteApplied();
}

export async function syncNow() {
  if (!accessToken || syncing) return;
  syncing = true; cbs.onStatusChange?.();
  try {
    if (!fileId) fileId = await findFile();
    const localLC = await db.getSetting('lastChangeAt', 0);
    if (!fileId) { await push(); return; }
    const remote = await downloadFile(fileId);
    const remoteLC = remote?.lastChangeAt || 0;
    if (remoteLC > localLC) await applyRemote(remote);
    else if (localLC > remoteLC) await push();
    else lastSyncAt = new Date();
  } finally { syncing = false; cbs.onStatusChange?.(); }
}

function schedulePush() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    if (!accessToken) return;
    try { if (!fileId) fileId = await findFile(); await push(); cbs.onStatusChange?.(); }
    catch (_) { /* offline etc.; next change or manual sync retries */ }
  }, 2500);
}

// ---------- public actions ----------
export async function connect(interactive) {
  await acquireToken(interactive);
  await fetchEmail();
  await db.setSetting('gdriveEnabled', true);
  await syncNow();
}

export async function disconnect() {
  try { if (accessToken) google.accounts.oauth2.revoke(accessToken, () => {}); } catch (_) {}
  accessToken = null; email = null; fileId = null;
  await db.setSetting('gdriveEnabled', false);
  await db.setSetting('gdriveEmail', null);
}

export async function init(callbacks) {
  cbs = callbacks || {};
  db.onDataChange(() => { if (accessToken) schedulePush(); });
  if (await db.getSetting('gdriveEnabled', false)) {
    email = await db.getSetting('gdriveEmail', null); // show last-known email while reconnecting
    try { await connect(false); } // silent — no UI unless Google requires it
    catch (_) { accessToken = null; cbs.onStatusChange?.(); } // UI offers Reconnect
  }
}
