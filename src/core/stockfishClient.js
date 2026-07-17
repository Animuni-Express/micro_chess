// Local Stockfish is only fetched on demand (when the user picks "Local Stockfish"),
// so pages that never use it never pay for the download — this matters a lot on
// Kindle's slow network.
const STOCKFISH_CDN_URL = 'https://cdnjs.cloudflare.com/ajax/libs/stockfish.js/10.0.0/stockfish.js';

let worker = null;
let isReady = false;

export function initLocalStockfish(onMove, onReady) {
  return new Promise((resolve, reject) => {
    if (typeof Worker === 'undefined') {
      reject(new Error('Web Workers not supported in this browser'));
      return;
    }

    // Browsers refuse `new Worker(crossOriginUrl)` outright (not a CORS-header
    // issue — cross-origin worker scripts are disallowed by spec). Fetch the
    // script text ourselves and construct the worker from a same-origin Blob URL.
    fetch(STOCKFISH_CDN_URL)
      .then((res) => {
        if (!res.ok) throw new Error('Failed to download Stockfish (status ' + res.status + ')');
        return res.text();
      })
      .then((scriptText) => {
        const blobUrl = URL.createObjectURL(new Blob([scriptText], { type: 'application/javascript' }));
        try {
          worker = new Worker(blobUrl);
        } catch (err) {
          reject(err);
          return;
        }
        wireWorker(worker, resolve, reject, onMove, onReady);
      })
      .catch(reject);
  });
}

function wireWorker(worker, resolve, reject, onMove, onReady) {
  worker.onmessage = (e) => {
    const msg = e.data;
    if (msg === 'uciok') {
      isReady = true;
      if (onReady) onReady();
      resolve();
    } else if (typeof msg === 'string' && msg.startsWith('bestmove')) {
      const move = msg.split(' ')[1];
      if (move && move.length >= 4 && onMove) {
        onMove(move.substring(0, 2), move.substring(2, 4), move.length > 4 ? move.substring(4, 5) : undefined);
      }
    }
  };
  worker.onerror = () => reject(new Error('Stockfish worker error'));
  worker.postMessage('uci');
  worker.postMessage('isready');
}

export function isLocalStockfishReady() {
  return isReady;
}

export function requestLocalMove(fen, level) {
  if (!worker) return;
  worker.postMessage('setoption name Skill Level value ' + level);
  worker.postMessage('position fen ' + fen);
  worker.postMessage('go depth ' + level);
}

export function newLocalGame() {
  if (worker) worker.postMessage('ucinewgame');
}

export function terminateLocalStockfish() {
  if (worker) {
    worker.terminate();
    worker = null;
    isReady = false;
  }
}

// --- Cloud engines (no download, single HTTP request per move) ---

export function requestChessApiMove(fen, depth) {
  return fetch('https://chess-api.com/v1', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fen, depth: Math.min(depth, 15) }),
  })
    .then((r) => r.json())
    .then((data) => data.move || null);
}

export function requestLichessMove(fen) {
  return fetch('https://lichess.org/api/cloud-eval?fen=' + encodeURIComponent(fen))
    .then((r) => r.json())
    .then((data) => (data.pvs && data.pvs[0] ? data.pvs[0].moves.split(' ')[0] : null));
}

export function requestSupabaseMove(fen, depth) {
  if (typeof window.getSupabase !== 'function') return Promise.resolve(null);
  const supabase = window.getSupabase();
  if (!supabase) return Promise.resolve(null);
  return supabase.functions
    .invoke('stockfish', { body: { fen, depth } })
    .then((res) => (res.data && res.data.bestmove) || null)
    .catch(() => null);
}

export function fallbackMove(game) {
  const moves = game.moves({ verbose: true });
  if (!moves.length) return null;
  moves.sort((a, b) => {
    const aCapture = a.flags.indexOf('c') !== -1;
    const bCapture = b.flags.indexOf('c') !== -1;
    if (aCapture === bCapture) return 0;
    return aCapture ? -1 : 1;
  });
  return moves[0];
}
