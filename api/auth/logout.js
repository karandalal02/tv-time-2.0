// Disconnect: best-effort revoke the refresh token at Google, then clear cookies.
import { serializeCookie } from '../_google.js';

export default async function handler(req, res) {
  const rt = req.cookies?.rt ? decodeURIComponent(req.cookies.rt) : '';
  if (rt) {
    try { await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(rt), { method: 'POST' }); }
    catch (_) { /* ignore */ }
  }
  res.setHeader('Set-Cookie', [
    serializeCookie('rt', '', { maxAge: 0 }),
    serializeCookie('em', '', { maxAge: 0, httpOnly: false })
  ]);
  res.status(200).json({ ok: true });
}
