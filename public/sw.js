/*
 * navWeather service worker — the app shell and our data files, for speed and offline use (ADR-019).
 *
 * - Same-origin hashed assets (/assets/*): cache-first (immutable).
 * - Page navigations: network-first, falling back to the cached shell.
 * - Our data in build/run folders (/data/roads/<build>/…, /data/search/<build>/…, /data/weather/runs/…,
 *   /data/air/runs/…): cache-first — those files never change. The cache keeps the most recent DATA_MAX files;
 *   they are region files (roads, search words, forecast tiles), on this device only, never sent anywhere.
 * - Index files (which build is current) and anything cross-origin (map tiles) are never cached here; the API
 *   (live sharing, reports) neither.
 */
const PREFIX = 'navweather-shell-';
const VERSION = `${PREFIX}v5`;
const DATA = 'navweather-data-v1';
const DATA_MAX = 600;
const IMMUTABLE_DATA = /^\/data\/(roads\/[^/]+\/|search\/[^/]+\/|weather\/runs\/|air\/runs\/|basemap\/m\d+\/|basemap\/assets\/)/;
/** The downloadable voice was removed; free the space it took (~93 MB) on devices that had it. */
const RETIRED = ['navweather-voices-v1'];
const SHELL = ['/', '/manifest.webmanifest', '/favicon.svg', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      // Older app shells and retired caches; anything else is not ours to delete.
      .then((keys) => Promise.all(keys.filter((k) => (k.startsWith(PREFIX) && k !== VERSION) || (k.startsWith('navweather-data-') && k !== DATA) || RETIRED.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never touch provider / tile traffic
  if (url.pathname.startsWith('/api/')) return; // live data (share positions) is never cached

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          // Only a real app page may become the offline shell.
          if (res.ok && (res.headers.get('content-type') || '').includes('text/html')) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put('/', copy));
          }
          return res;
        })
        .catch(() => caches.match('/')),
    );
    return;
  }

  if (IMMUTABLE_DATA.test(url.pathname)) {
    event.respondWith(
      caches.open(DATA).then((cache) =>
        cache.match(req).then(
          (hit) =>
            hit ||
            fetch(req).then((res) => {
              if (res.ok && !(res.headers.get('content-type') || '').includes('text/html')) {
                cache.put(req, res.clone()).then(() => trim(cache));
              }
              return res;
            }),
        ),
      ),
    );
    return;
  }

  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(VERSION).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
  }
});

/** Keep the data cache to its most recent DATA_MAX files (oldest first out). */
let trimming = false;
function trim(cache) {
  if (trimming) return;
  trimming = true;
  cache
    .keys()
    .then((keys) => Promise.all(keys.slice(0, Math.max(0, keys.length - DATA_MAX)).map((k) => cache.delete(k))))
    .finally(() => {
      trimming = false;
    });
}
