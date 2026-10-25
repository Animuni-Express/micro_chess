import { Chess } from 'chess.js';
import { LIMITS } from './config.js';

export function applyUci(game, uci) {
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) throw new Error('Invalid move');
  const move = game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  if (!move) throw new Error('Illegal move');
  return move;
}
// SHA-256 truncated to 128 bits: all six FEN fields AND the complete UCI prefix.
// History is included because FEN alone cannot preserve repetition claims.
export async function positionDigest(game, history) {
  const bytes = new TextEncoder().encode(game.fen() + '\n' + history.map(m => m.uci).join(' '));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash).slice(0, 16), b => b.toString(16).padStart(2, '0')).join('');
}
export async function replay(history) {
  if (!Array.isArray(history) || history.length > LIMITS.moves) throw new Error('Invalid history');
  const game = new Chess(), moves = [];
  for (const entry of history) {
    const move = applyUci(game, entry.uci);
    moves.push({ uci: entry.uci, digest: entry.digest, san: move.san });
    if (await positionDigest(game, moves) !== entry.digest) throw new Error('Position mismatch');
  }
  return { game, history: moves };
}
export async function reconcile(a, b) {
  await replay(a); await replay(b);
  let length = 0;
  while (length < Math.min(a.length, b.length) && a[length].uci === b[length].uci && a[length].digest === b[length].digest) length++;
  // A divergent move is unsafe. A missing unacknowledged tail can be rolled back.
  if (length < Math.min(a.length, b.length)) throw new Error('Histories disagree');
  return replay(a.slice(0, length));
}
