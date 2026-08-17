// Generated to ./sw.js by build.mjs, which substitutes 319976afe068 with a
// hash of the built index.html. That substitution is the whole point: a
// browser only looks for an updated service worker when sw.js itself changes
// byte for byte. With a fixed cache name and a fixed body, an installed copy
// served its first cached index.html forever and no later deploy could ever
// reach the device.
const VERSION = '319976afe068';
const CACHE = 'orto-review-' + VERSION;
const SHELL = [
  './', './index.html', './manifest.webmanifest',
  './icon-192.png', './icon-512.png', './icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // cache: 'reload' so the shell comes from the network rather than from an
    // HTTP cache that may still hold the previous deploy. One unreachable
    // entry must not abort the whole install.
    await Promise.all(SHELL.map(async (u) => {
      try {
        const r = await fetch(new Request(u, { cache: 'reload' }));
        if (r && r.ok) await c.put(u, r);
      } catch (_) { /* leave it to be filled in on first use */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// Stale-while-revalidate. The cached copy answers immediately, so the app
// still opens instantly and works offline, but every hit also refreshes the
// entry in the background — a second line of defence if the version bump
// above ever fails to trigger an update.
function swr(e, key) {
  return (async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(key, { ignoreSearch: true });
    const net = fetch(e.request).then((r) => {
      if (r && r.ok) cache.put(key, r.clone());
      return r;
    }).catch(() => null);
    if (hit) {
      e.waitUntil(net);   // keep the worker alive for the refresh
      return hit;
    }
    return (await net) || Response.error();
  })();
}

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  if (e.request.mode === 'navigate') { e.respondWith(swr(e, './index.html')); return; }
  // Imagery and API calls are cross-origin and must pass straight through:
  // tiles have their own IndexedDB cache, and candidate data must never be
  // served stale.
  if (new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(swr(e, e.request));
});
