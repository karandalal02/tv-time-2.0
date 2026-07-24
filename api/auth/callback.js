// Step 2 of sign-in: Google redirects here with a one-time code. We exchange it
// (server-side, using the client secret) for an access token AND a refresh
// token, then store the refresh token in a Secure/HttpOnly first-party cookie.
// The browser never sees the refresh token. Finally, redirect back to the app.
import { exchangeCode, decodeEmail, serializeCookie, baseUrl } from '../_google.js';

const YEAR = 60 * 60 * 24 * 400; // ~13 months

export default async function handler(req, res) {
  const app = baseUrl(req);
  const { code, state, error } = req.query || {};
  const savedState = req.cookies?.oauth_state;

  if (error) { res.redirect(`${app}/?auth=denied`); return; }
  if (!code || !state || !savedState || state !== savedState) {
    res.redirect(`${app}/?auth=badstate`); return;
  }

  try {
    const tok = await exchangeCode(code, req);
    const email = tok.id_token ? decodeEmail(tok.id_token) : '';
    res.setHeader('Set-Cookie', [
      serializeCookie('oauth_state', '', { maxAge: 0 }),
      serializeCookie('rt', encodeURIComponent(tok.refresh_token || ''), { maxAge: YEAR }),
      serializeCookie('em', encodeURIComponent(email), { maxAge: YEAR, httpOnly: false })
    ]);
    res.redirect(`${app}/?auth=ok`);
  } catch (_) {
    res.redirect(`${app}/?auth=fail`);
  }
}
