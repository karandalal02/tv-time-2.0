# Tally — a private TV & movie tracker

A pure, social-free replacement for TV Time. Track **TV shows and movies**: mark
episodes/movies watched, see what's **Up Next**, keep a **Watchlist**, check the
**Calendar** of upcoming episodes and releases, and view your **Stats**.
Everything is stored **locally on your device** — no account, no server, no tracking.

**Layout:** four tabs at the bottom —
- **TV** — Up Next / Calendar
- **Movies** — Up Next / Calendar
- **Search** — find TV shows and movies
- **You** — Library (TV + Movies rows, most-recently-watched first, "See all" to
  open a full list) with your Stats underneath

It's a **PWA** (Progressive Web App): plain HTML/CSS/JavaScript, no build step,
no Node. Add it to your iPhone Home Screen and it behaves like a native app.

---

## 1. Get a free TMDB key (2 minutes)

Show data comes from [The Movie Database](https://www.themoviedb.org) (free).

1. Create an account at themoviedb.org.
2. Go to **Settings → API** → request a **Developer** key (personal use).
3. Copy either the **API Key (v3 auth)** or the **API Read Access Token (v4)**.

You'll paste this into the app's **⚙ Settings** once. It's stored only on your device.

---

## 2. Run it locally (to try it on your computer)

From this folder:

```bash
python3 -m http.server 8123
```

Then open **http://localhost:8123** in your browser. Open **⚙ Settings**, paste
your TMDB key, and start searching for shows.

> A local server is needed (not opening the file directly) because the app uses
> JavaScript modules and a service worker.

---

## 3. Put it on your iPhone (free, no App Store)

To use it as an app on your phone, the files need to be served over HTTPS. Pick
any free static host and drag this folder in:

- **Netlify Drop** — https://app.netlify.com/drop (drag the folder, done)
- **Vercel** — https://vercel.com (import folder / `vercel` CLI)
- **GitHub Pages** — push to a repo, enable Pages
- **Cloudflare Pages** — https://pages.cloudflare.com

Then on your iPhone:

1. Open the deployed URL in **Safari**.
2. Tap the **Share** icon → **Add to Home Screen**.
3. Launch **Tally** from the Home Screen — it opens fullscreen, works offline,
   and remembers everything.

Enter your TMDB key once in Settings and you're set.

---

## Features

- **TV & Movies** — track both, kept in separate sections
- **Up Next** — the next unwatched episode across every show you're watching
- **Episode tracking** — mark a single episode, a whole season, or the **entire show** at once
- **Movies** — watchlist + mark watched; "watched it all" shortcut when adding a show you've finished
- **Status badges** — see at a glance whether a show is **Ongoing**, **Ended**, or **Canceled**
- **Calendar** — upcoming episodes and movie releases for items in your library
- **Search** — find any show or movie via TMDB
- **Stats** — episodes, movies, hours/days watched, shows completed, average rating (per media type)
- **Ratings** — simple 1–5 stars (tap the same star again to clear)
- **Backup** — Settings → Export / Import your data as JSON

## Backup your data

Your data lives in the browser's storage on one device. In **⚙ Settings**:
- **Export data** downloads a JSON backup.
- **Import data** restores it (also how you'd move to a new device).

## Files

```
index.html            app shell
styles.css            styling (dark, mobile-first)
manifest.webmanifest  PWA manifest
sw.js                 service worker (offline + installable)
make_icons.py         regenerates the app icons
icons/                app icons
js/
  app.js              UI, routing, views
  api.js              TMDB client
  db.js               IndexedDB storage
  store.js            tracking logic (up next, progress, stats…)
```

## Updating

After editing app files, bump the cache name in `sw.js` (`tally-v1` → `tally-v2`)
so devices pick up the new version on next launch.
