// Minimal Upstash Redis REST client (plain fetch — no client library needed,
// which fits Vercel's serverless functions well). Powers a lightweight usage
// roster: who has signed in, and how many shows/movies they've saved.
// Never stores show/movie titles or watch history — counts only.
const BASE = process.env.KV_REST_API_URL;
const RW_TOKEN = process.env.KV_REST_API_TOKEN;
const RO_TOKEN = process.env.KV_REST_API_READ_ONLY_TOKEN;

export function configured() { return !!(BASE && RW_TOKEN); }

async function run(command, token) {
  const res = await fetch(BASE, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command)
  });
  if (!res.ok) throw new Error('kv_http_' + res.status);
  return (await res.json()).result;
}

export async function pipeline(commands, token = RW_TOKEN) {
  const res = await fetch(`${BASE}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands)
  });
  if (!res.ok) throw new Error('kv_http_' + res.status);
  return res.json();
}

export const sadd = (key, member) => run(['SADD', key, member], RW_TOKEN);
export const smembers = (key) => run(['SMEMBERS', key], RO_TOKEN || RW_TOKEN);

// HGETALL's wire shape can be a flat [field, value, ...] array depending on
// the REST mode — normalize to a plain object either way.
export async function hgetallObj(key) {
  const raw = await run(['HGETALL', key], RO_TOKEN || RW_TOKEN);
  if (!raw) return {};
  if (Array.isArray(raw)) {
    const obj = {};
    for (let i = 0; i < raw.length; i += 2) obj[raw[i]] = raw[i + 1];
    return obj;
  }
  return raw;
}
