const loaded = new Set();

// Injects a <script> tag once and resolves when it loads — used to defer
// heavy/rarely-needed CDN scripts (Supabase SDK, local Stockfish) so they
// never block first paint, especially on slow Kindle connections.
export function loadScriptOnce(src) {
  if (loaded.has(src)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => {
      loaded.add(src);
      resolve();
    };
    s.onerror = () => reject(new Error('Failed to load ' + src));
    document.head.appendChild(s);
  });
}
