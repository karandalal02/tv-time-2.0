// Service worker: caches the app shell so Tally launches offline and installs
// as a PWA. TMDB API calls fall through to the network (and are cached
// opportunistically so recently viewed shows keep working offline).
const CACHE = 'tvtime2-v1';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './js/app.js',
  './js/api.js',
  './js/db.js',
  './js/store.js',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  // TMDB API (api.themoviedb.org) + images (image.tmdb.org): network-first,
  // fall back to cache so recently viewed content works offline.
  if (url.hostname.endsWith('themoviedb.org') || url.hostname.endsWith('tmdb.org')) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // App shell: cache-first.
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request))
  );
});
