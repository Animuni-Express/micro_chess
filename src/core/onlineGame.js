import { Chess } from 'chess.js';

export const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

// `|| STARTING_FEN` rather than a default parameter: callers pass a FEN read off
// a possibly-absent game object, which can arrive as null (not undefined), and a
// default parameter would not catch that — chess.js then throws on fen.split().
export function createOnlineGame(fen) {
  return new Chess(fen || STARTING_FEN);
}

export function movePayload(game, from, to, promotion) {
  const candidate = new Chess(game.fen());
  const move = candidate.move({ from, to, promotion });
  if (!move) return null;
  return {
    from,
    to,
    promotion: promotion || null,
    san: move.san,
    fenAfter: candidate.fen(),
  };
}

export function gameResult(game) {
  if (game.in_checkmate()) return game.turn() === 'w' ? 'black_won' : 'white_won';
  if (game.in_stalemate() || game.in_draw()) return 'draw';
  return null;
}
