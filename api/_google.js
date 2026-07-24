// Shared helpers for the Google OAuth backend. Not a route (underscore prefix),
// so Vercel never serves it — it's imported by the /api/auth/* functions.
//
// Design: the classic "backend for frontend" (BFF). Google's refresh token is
// held in a Secure, HttpOnly, first-party cookie on this same origin. The app
// asks /api/auth/token for a short-lived access token whenever it needs one.
// Because it's all one origin, the cookie is first-party — never blocked by
// Firefox/Safari tracking protection. That's what makes "sign in once" stick.

export const SCOPES = 'openid email https://www.googleapis.com/auth/drive.appdata';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export function baseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}
export function redirectUri(req) { return `${baseUrl(req)}/api/auth/callback`; }

export function serializeCookie(name, value, { maxAge, httpOnly = true } = {}) {
  const parts = [`${name}=${value}`, 'Path=/', 'Secure', 'SameSite=Lax'];
  if (httpOnly) parts.push('HttpOnly');
  if (maxAge != null) parts.push(`Max-Age=${maxAge}`);
  return parts.join('; ');
}

async function tokenRequest(params) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params)
  });
  if (!res.ok) throw new Error('google_token_' + res.status);
  return res.json();
}

export function exchangeCode(code, req) {
  return tokenRequest({
    code,
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    redirect_uri: redirectUri(req),
    grant_type: 'authorization_code'
  });
}

export function refreshAccess(refreshToken) {
  return tokenRequest({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: refreshToken
  });
}

export function decodeEmail(idToken) {
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64').toString('utf8'));
    return payload.email || '';
  } catch { return ''; }
}

export function configured() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}
