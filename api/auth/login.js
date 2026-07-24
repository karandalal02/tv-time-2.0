// Step 1 of sign-in: full-page redirect to Google's consent screen.
// A top-level redirect is a first-party visit to Google, so mobile Firefox /
// Safari tracking protection does not block it (unlike the popup/iframe method).
import crypto from 'node:crypto';
import { SCOPES, redirectUri, serializeCookie, configured } from '../_google.js';

export default function handler(req, res) {
  if (!configured()) {
    res.status(500).send('Server not configured: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Vercel.');
    return;
  }
  const state = crypto.randomBytes(16).toString('hex');
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(req),
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',        // ask for a refresh token
    include_granted_scopes: 'true',
    prompt: 'consent',             // ensure a refresh token is returned
    state
  });
  res.setHeader('Set-Cookie', serializeCookie('oauth_state', state, { maxAge: 600 }));
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
}
