// The app calls this on every open (and whenever its access token expires) to
// get a fresh, short-lived Google access token. The refresh token stays in the
// HttpOnly cookie and never reaches the browser. Same-origin + SameSite=Lax
// means the cookie is always sent here but cannot be read cross-site.
import { refreshAccess } from '../_google.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const rt = req.cookies?.rt ? decodeURIComponent(req.cookies.rt) : '';
  const email = req.cookies?.em ? decodeURIComponent(req.cookies.em) : '';
  if (!rt) { res.status(401).json({ error: 'not_connected' }); return; }
  try {
    const t = await refreshAccess(rt);
    res.status(200).json({ access_token: t.access_token, expires_in: t.expires_in, email });
  } catch (_) {
    // Refresh token revoked/expired — the app will prompt to reconnect.
    res.status(401).json({ error: 'refresh_failed' });
  }
}
