// Read-only usage roster: email, first-seen, last-active, and show/movie
// counts only — never titles or watch history. Gated by ADMIN_KEY (set your
// own value for that env var in Vercel; nobody can view this without it).
import { smembers, hgetallObj, configured } from '../_kv.js';

export default async function handler(req, res) {
  if (!process.env.ADMIN_KEY || req.headers['x-admin-key'] !== process.env.ADMIN_KEY) {
    res.status(401).json({ error: 'unauthorized' }); return;
  }
  if (!configured()) { res.status(200).json({ users: [] }); return; }
  try {
    const emails = (await smembers('users:index')) || [];
    const users = await Promise.all(emails.map(async (email) => {
      const h = await hgetallObj(`user:${email}`);
      return {
        email,
        firstSeen: h.firstSeen || null,
        lastActive: h.lastActive || null,
        shows: Number(h.shows || 0),
        movies: Number(h.movies || 0)
      };
    }));
    users.sort((a, b) => (b.lastActive || '').localeCompare(a.lastActive || ''));
    res.status(200).json({ users });
  } catch (_) {
    res.status(500).json({ error: 'kv_error' });
  }
}
