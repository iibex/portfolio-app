// Service worker: makes the app open instantly and work offline (showing the last known prices).
// Bump VERSION whenever app files change so phones pick up the new version.
const VERSION = 'v0.1.0';
const CACHE = `portfolio-${VERSION}`;
const SHELL = [
  './',
  'index.html',
  'css/app.css',
  'js/app.js',
  'js/store.js',
  'js/portfolio.js',
  'js/prices.js',
  'js/format.js',
  'js/csv.js',
  'js/importers/index.js',
  'js/importers/bitvavo.js',
  'js/importers/degiro.js',
  'js/importers/generic.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('portfolio-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // price APIs: always network
  // Network first (so updates arrive), cache as offline fallback.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('index.html'))),
  );
});
