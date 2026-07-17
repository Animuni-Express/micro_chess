const CACHE_NAME = 'micro-chess-v6';
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/over_the_board.html',
  '/stockfish.html',
  '/over_the_board_kindle.html',
  '/stockfish_kindle.html',
  '/about.html',
  '/style.css',
  '/style_kindle.css',
  '/sw.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/public/bundle.js',
  '/public/bundle-kindle.js',
  '/js/supabase_client.js',
  '/pieces/wp.svg',
  '/pieces/wn.svg',
  '/pieces/wb.svg',
  '/pieces/wr.svg',
  '/pieces/wq.svg',
  '/pieces/wk.svg',
  '/pieces/bp.svg',
  '/pieces/bn.svg',
  '/pieces/bb.svg',
  '/pieces/br.svg',
  '/pieces/bq.svg',
  '/pieces/bk.svg',
];

/* ---------- Install: cache all core shell files ---------- */
self.addEventListener('install', (event) => {
  event.waitUntil(
    // Cache each URL independently — a single missing/404 asset must not
    // fail the whole install and strand an old service worker in control.
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(
        PRECACHE_URLS.map((url) =>
          cache.add(url).catch((err) => console.warn('[sw] precache failed for', url, err))
        )
      )
    )
  );
  // Claim immediately so the SW controls pages on first load.
  self.skipWaiting();
});

/* ---------- Activate: purge old caches ---------- */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      )
    )
  );
  self.clients.claim();
});

/* ---------- Fetch: cache-first for static assets -------------- */
// Strategy: static assets (CSS/JS/images) → cache-first.
// API / CDN / external fetches → network-first (fall back to cache).
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle GET requests.
  if (request.method !== 'GET') return;

  // Network-first for CDN/external URLs or Supabase calls
  if (url.origin !== self.location.origin || url.pathname.startsWith('/functions/')) {
    event.respondWith(networkFirst(request));
    return;
  }

  // Cache-first for static assets
  event.respondWith(cacheFirst(request));
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    // Offline fallback — never resolve to undefined, respondWith() requires a real Response.
    if (request.destination === 'document') {
      const fallback = await caches.match('/index.html');
      if (fallback) return fallback;
    }
    return new Response('Offline', { status: 503 });
  }
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await caches.match(request);
    return cached || new Response('Offline', { status: 503 });
  }
}
