# Deploying TV Time 2.0 on Vercel (sign-in-once Google sync)

The app now has a small backend (`/api/auth/*`) that keeps you signed in to Google
permanently. This guide gets it running on Vercel (free). One-time, ~15 minutes.

Your code stays in GitHub — Vercel just deploys from it and auto-updates on every push.

---

## 1. Deploy the repo to Vercel

1. Go to **https://vercel.com** → **Sign up** → **Continue with GitHub**.
2. **Add New… → Project** → find **`tv-time-2.0`** → **Import**.
3. Framework Preset: **Other** (leave build settings empty). Click **Deploy**.
4. When it finishes, note your app URL, e.g. **`https://tv-time-2-0.vercel.app`**
   (Vercel shows it — copy the exact one).

## 2. Get your Google **Client Secret**

1. Go to **https://console.cloud.google.com** → your **TV Time 2** project.
2. **APIs & Services → Credentials** → click your existing **OAuth client** (the Web one).
3. On the right you'll see **Client secret** — copy it. (You already have the Client ID.)

## 3. Add the two secrets to Vercel

In your Vercel project → **Settings → Environment Variables**, add:

| Name | Value |
|---|---|
| `GOOGLE_CLIENT_ID` | `96994450295-fd1njai4bpv2bq0pq01o6ht3j3t7brgh.apps.googleusercontent.com` |
| `GOOGLE_CLIENT_SECRET` | *(the secret you just copied)* |

Then **Deployments → ⋯ on the latest → Redeploy** so the variables take effect.

## 4. Tell Google to trust your Vercel URL

Back in **Google Console → Credentials → your OAuth client**:

1. **Authorized redirect URIs → Add URI:**
   `https://YOUR-VERCEL-URL/api/auth/callback`
   (use the exact domain from step 1, e.g. `https://tv-time-2-0.vercel.app/api/auth/callback`)
2. **Authorized JavaScript origins → Add URI:** `https://YOUR-VERCEL-URL`
3. **Save.**

## 5. Make sign-in "stick" forever

Still in Google Console → **APIs & Services → OAuth consent screen** (a.k.a. *Google Auth Platform → Audience*):

- Set **Publishing status** to **In production** (click **Publish app** / **Push to production**).
  This is what stops Google from expiring your sign-in after 7 days.
- Verification isn't needed for personal use — you'll just click through a one-time
  "Google hasn't verified this app" screen (Advanced → Continue). It's your own app.

---

## Done — try it

Open your Vercel URL → **Sign in with Google** → approve once. You're now signed in
permanently: it syncs to your own Google Drive and stays connected across your Mac,
phone (Firefox included), everywhere — no repeated logins.

**Add to Home Screen** on your phone from the Vercel URL for the app experience.

### Notes
- The old `karandalal02.github.io` link still works but has no backend/sync — use the
  Vercel URL from now on. Your data re-syncs from Drive, so nothing is lost.
- To bring over data from a device: Settings → **Export** on the old one, **Import** on the new.
- Updates: I push to GitHub → Vercel auto-deploys. (Bump `CACHE` in `sw.js` per change.)
