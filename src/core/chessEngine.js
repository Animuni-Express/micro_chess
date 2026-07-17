import { Chess } from 'chess.js';

// Single source of truth for game + UI selection state. Both the desktop
// Preact app and the Kindle bundle import this module, so there is never
// more than one Chess() instance alive at a time.

let game = new Chess();

let selection = {
  selectedSquare: null,
  validMoves: [],
};

export function getGame() {
  return game;
}

export function newGame() {
  game = new Chess();
  clearSelection();
  return game;
}

export function getSelection() {
  return selection;
}

export function selectSquare(square) {
  selection = { selectedSquare: square, validMoves: game.moves({ square, verbose: true }) };
}

export function clearSelection() {
  selection = { selectedSquare: null, validMoves: [] };
}

export function isPromotion(from, to) {
  const piece = game.get(from);
  const toRank = to[1];
  if (!piece || piece.type !== 'p' || (toRank !== '8' && toRank !== '1')) return false;
  return game.moves({ square: from, verbose: true }).some((m) => m.to === to);
}

export function makeMove(from, to, promotion) {
  const result = game.move({ from, to, promotion });
  if (result) clearSelection();
  return !!result;
}

export function undoMove() {
  game.undo();
  clearSelection();
}

export function gameStatusText(playerColor) {
  const turn = game.turn();
  const turnLabel = turn === 'w' ? 'White' : 'Black';
  if (game.in_checkmate()) {
    const winner = turn === 'w' ? 'Black' : 'White';
    return `Checkmate! ${winner} wins!`;
  }
  if (game.in_stalemate()) return 'Stalemate!';
  if (game.in_draw()) return 'Draw!';
  if (game.in_check()) return `⚠️ ${turnLabel} is in check!`;
  if (playerColor) return turn === playerColor ? 'Your move' : "AI's turn";
  return `${turnLabel}'s turn to move`;
}
