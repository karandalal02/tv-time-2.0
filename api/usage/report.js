// Records aggregate counts only (never show/movie titles or watch history) so
// the app owner can see how many people use the app and how much. Best-effort:
// any failure here must never affect the app's own Drive sync.
import { pipeline, configured } from '../_kv.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).end(); return; }
  const email = req.cookies?.em ? decodeURIComponent(req.cookies.em) : '';
  if (!email || !req.cookies?.rt) { res.status(401).json({ error: 'not_connected' }); return; }
  if (!configured()) { res.status(200).json({ ok: false }); return; }

  const shows = Math.max(0, Number(req.body?.shows) || 0);
  const movies = Math.max(0, Number(req.body?.movies) || 0);
  const now = new Date().toISOString();
  try {
    await pipeline([
      ['SADD', 'users:index', email],
      ['HSETNX', `user:${email}`, 'firstSeen', now],
      ['HSET', `user:${email}`, 'email', email, 'lastActive', now, 'shows', String(shows), 'movies', String(movies)]
    ]);
    res.status(200).json({ ok: true });
  } catch (_) {
    res.status(200).json({ ok: false }); // never surface as an error to the client
  }
}
