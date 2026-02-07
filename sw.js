// Define the name of the cache for versioning control
const CACHE_NAME = 'chess-offline-v16';

// Define the array of files and resources to be cached for offline use
const FILES_TO_CACHE = [
    // Core application files
    './', // Root directory
    './index.html', // Main landing page
    './about.html', // About page
    './over_the_board.html', // Main game page
    './over_the_board_kindle.html', // Kindle compatible page
    './stockfish.html', // Stockfish game page
    './stockfish_kindle.html', // Stockfish Kindle page
    './js/supabase_client.js', // Supabase Client
    './style.css', // External CSS
    './style_kindle.css', // Kindle External CSS

    // External Libraries (Chess logic)
    'https://unpkg.com/chess.js@1.0.0-beta.8/dist/esm/chess.js',
    'https://cdnjs.cloudflare.com/ajax/libs/chess.js/0.10.3/chess.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/stockfish.js/10.0.0/stockfish.js', // Stockfish Engine

    // Chess Piece Images (Wikimedia Commons SVGs)
    // White Pieces
    'https://upload.wikimedia.org/wikipedia/commons/4/45/Chess_plt45.svg', // Pawn
    'https://upload.wikimedia.org/wikipedia/commons/7/70/Chess_nlt45.svg', // Knight
    'https://upload.wikimedia.org/wikipedia/commons/b/b1/Chess_blt45.svg', // Bishop
    'https://upload.wikimedia.org/wikipedia/commons/7/72/Chess_rlt45.svg', // Rook
    'https://upload.wikimedia.org/wikipedia/commons/1/15/Chess_qlt45.svg', // Queen
    'https://upload.wikimedia.org/wikipedia/commons/4/42/Chess_klt45.svg', // King

    // Black Pieces
    'https://upload.wikimedia.org/wikipedia/commons/c/c7/Chess_pdt45.svg', // Pawn
    'https://upload.wikimedia.org/wikipedia/commons/e/ef/Chess_ndt45.svg', // Knight
    'https://upload.wikimedia.org/wikipedia/commons/9/98/Chess_bdt45.svg', // Bishop
    'https://upload.wikimedia.org/wikipedia/commons/f/ff/Chess_rdt45.svg', // Rook
    'https://upload.wikimedia.org/wikipedia/commons/4/47/Chess_qdt45.svg', // Queen
    'https://upload.wikimedia.org/wikipedia/commons/f/f0/Chess_kdt45.svg'  // King
];

// Event listener for the 'install' event
// This runs when the service worker is first installed
self.addEventListener('install', (event) => {
    // Force this service worker to become active immediately
    self.skipWaiting();
    // specific task to perform during installation
    event.waitUntil(
        // Open the cache storage with the defined name
        caches.open(CACHE_NAME).then((cache) => {
            // Add all defined files to the cache
            return cache.addAll(FILES_TO_CACHE).then(() => {
                console.log('SW Finished Collecting pages. site ready for offline use');
            });
        })
    );
});

// Event listener for the 'activate' event
// This runs when the service worker activates (e.g., after an update)
self.addEventListener('activate', (event) => {
    // specific task to perform during activation
    event.waitUntil(
        Promise.all([
            // Claim control of all clients immediately
            self.clients.claim(),
            // Clean up old caches that don't match the current CACHE_NAME
            caches.keys().then((cacheNames) => {
                return Promise.all(
                    cacheNames.map((cacheName) => {
                        // If the cache name is different from the current one
                        if (cacheName !== CACHE_NAME) {
                            // Delete the old cache to free up space
                            return caches.delete(cacheName);
                        }
                    })
                );
            })
        ])
    );
});

// Event listener for the 'fetch' event
// This intercepts network requests to serve cached content when offline
self.addEventListener('fetch', (event) => {
    // Respond to the fetch event with our custom logic
    event.respondWith(
        // First, check if the request is already in the cache
        caches.match(event.request).then((response) => {
            // If found in cache, return it.
            if (response) {
                return response;
            }

            // Otherwise, fetch from network.
            return fetch(event.request).then((fetchResponse) => {
                // Check if the network response is valid
                if (!fetchResponse || fetchResponse.status !== 200 || fetchResponse.type !== 'basic') {
                    // Start of FIX: More robust caching checks

                    // Allow caching of opaque responses (like from CDNs/Wikimedia)
                    if (fetchResponse.type === 'opaque') {
                        return caches.open(CACHE_NAME).then((cache) => {
                            cache.put(event.request, fetchResponse.clone());
                            return fetchResponse;
                        });
                    }

                    // DO NOT cache errors (404, 500, etc.)
                    // Just return the response without caching it
                    return fetchResponse;
                }

                // For standard successful requests (status 200, basic type), cache them
                return caches.open(CACHE_NAME).then((cache) => {
                    cache.put(event.request, fetchResponse.clone());
                    return fetchResponse;
                });
            });
        }).catch(() => {
            // If both cache and network fail (offline and not cached)
            // Fallback to the index page (useful for SPA navigation, though this is a multi-page app)
            // Only return this for HTML navigations
            if (event.request.mode === 'navigate') {
                return caches.match('./index.html');
            }
            // Otherwise fail gracefully
        })
    );
});
