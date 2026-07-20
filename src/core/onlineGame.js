import { Chess } from 'chess.js';

export const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export function createOnlineGame(fen = STARTING_FEN) {
  return new Chess(fen);
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
