// =============================================================================
// field-sw.js — RWR Field PWA service worker (S9B).
// -----------------------------------------------------------------------------
// Minimal, opinionated worker:
//   * Cache-first for static assets shipped by Vite (/assets/*, /textures/*,
//     /cesium/*) and for the field manifest/icon SVGs.
//   * Network-first for HTML entries and /api/* — we never want to serve a
//     stale token-scoped API response from disk. The cache is used as a
//     fallback ONLY when the network is unreachable (and only for HTML).
//   * Activate event evicts caches that don't match the current `CACHE_VERSION`.
//   * No background sync (defer to S10).
//   * No push notifications yet.
// =============================================================================

const CACHE_VERSION = 'rwr-field-v2';
const STATIC_CACHE  = `${CACHE_VERSION}-static`;
const HTML_CACHE    = `${CACHE_VERSION}-html`;

// Routes the worker considers "static" — long-lived hashed assets.
const STATIC_PREFIXES = ['/assets/', '/textures/', '/cesium/', '/public/'];

// Routes that should ALWAYS hit network first (and never be cached as static).
const NETWORK_FIRST_PREFIXES = ['/api/', '/socket.io/'];

self.addEventListener('install', (event) => {
  // Activate ASAP so first navigation gets the worker.
  self.skipWaiting();
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) =>
      cache.addAll([
        '/field.html',
        '/field-manifest.json',
      ]).catch(() => { /* tolerate offline install */ }),
    ),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => !k.startsWith(CACHE_VERSION))
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

function isStatic(url) {
  return STATIC_PREFIXES.some((p) => url.pathname.startsWith(p));
}
function isNetworkFirst(url) {
  return NETWORK_FIRST_PREFIXES.some((p) => url.pathname.startsWith(p));
}
function isHtmlEntry(req) {
  if (req.mode === 'navigate') return true;
  const accept = req.headers.get('accept') || '';
  return accept.includes('text/html');
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Only handle GET — POST/PUT/DELETE pass straight to the network.
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.origin !== self.location.origin) return;

  // ---- 1. API + WebSocket: never cache ------------------------------------
  if (isNetworkFirst(url)) return;

  // ---- 2. Hashed static assets: cache-first --------------------------------
  if (isStatic(url)) {
    event.respondWith(
      caches.open(STATIC_CACHE).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        try {
          const res = await fetch(req);
          if (res && res.status === 200) cache.put(req, res.clone());
          return res;
        } catch (err) {
          return hit || Response.error();
        }
      }),
    );
    return;
  }

  // ---- 3. HTML entries: network-first, fallback to cache --------------------
  if (isHtmlEntry(req)) {
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(req);
          if (res && res.status === 200) {
            const cache = await caches.open(HTML_CACHE);
            cache.put(req, res.clone());
          }
          return res;
        } catch (err) {
          const cache = await caches.open(HTML_CACHE);
          // Only fall back to the field shell for FIELD navigations — this
          // worker is scoped to the whole origin (it's registered at /), so
          // serving /field.html for a failed dashboard/marketing navigation
          // would render the wrong (mobile) page. Other pages get a clean
          // network error instead of a misleading cached shell.
          const hit = await cache.match(req)
            || (url.pathname.startsWith('/field') ? await cache.match('/field.html') : null);
          if (hit) return hit;
          return Response.error();
        }
      })(),
    );
    return;
  }

  // ---- 4. Default: try network, swallow errors -----------------------------
  event.respondWith(
    fetch(req).catch(() => caches.match(req).then((r) => r || Response.error())),
  );
});
