import { Chess } from 'chess.js';
import { STARTING_FEN } from './onlineGame';

// Pure helpers for the state the `lichess` Edge Function returns. Lichess is the
// authority on the game, so it hands us the starting position plus the UCI move
// list and we replay it locally — nothing here talks to the network, which keeps
// it all unit-testable (tests/lichessGame.test.js).

export function relayStartingFen(initialFen) {
  return !initialFen || initialFen === 'startpos' ? STARTING_FEN : initialFen;
}

export function applyUciMoves(chess, moves) {
  const list = String(moves || '').trim();
  if (!list) return chess;
  for (const uci of list.split(/\s+/)) {
    const move = chess.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.slice(4, 5) || undefined,
    });
    if (!move) throw new Error(`Lichess sent a move this board cannot replay: ${uci}`);
  }
  return chess;
}

// Returns the best position it could build plus any replay error, rather than
// throwing: a board that renders with a warning beats a blank screen.
export function positionFromRelay(game) {
  const chess = new Chess(relayStartingFen(game?.initialFen));
  try {
    applyUciMoves(chess, game?.moves);
    return { chess, error: null };
  } catch (error) {
    return { chess, error: error.message };
  }
}

export function isOurTurn(game, turn) {
  return !!game && !game.finished && turn === game.color;
}

// Lichess reports each side's remaining time as of the last sync, so the side to
// move has been burning time since then. skewMs is (local clock - server clock),
// measured from the `serverNow` field, so a wrong device clock does not show a
// wildly wrong countdown.
export function relayClockRemaining(game, color, { now = Date.now(), turn, skewMs = 0 } = {}) {
  if (!game) return null;
  const base = color === 'w' ? game.whiteClockMs : game.blackClockMs;
  if (typeof base !== 'number') return null;
  if (game.finished || turn !== color || (game.moveCount || 0) < 1) return base;
  const since = game.lastSyncAt ? Date.parse(game.lastSyncAt) : NaN;
  if (!Number.isFinite(since)) return base;
  return Math.max(0, base - Math.max(0, now - skewMs - since));
}

export function canAbortRelayGame(game) {
  return !!game && !game.finished && (game.moveCount || 0) < 2;
}

const DRAW_STATUSES = new Set(['draw', 'stalemate']);

export function describeRelayResult(game, turn) {
  if (!game) return 'Loading game…';
  if (!game.finished) return turn === game.color ? 'Your move' : `${game.opponent?.name || 'Opponent'} to move`;
  if (game.status === 'aborted') return 'Game aborted — no result.';
  if (game.status === 'noStart') return 'Game aborted: nobody made a move.';
  // Any finished game without a winner is a draw (agreed, stalemate, 50-move,
  // insufficient material — Lichess reports them all as status 'draw').
  if (!game.winner || DRAW_STATUSES.has(game.status)) return 'Game drawn.';
  const won = game.winner === game.color;
  const opponent = game.opponent?.name || 'Your opponent';
  if (game.status === 'mate') return won ? 'Checkmate — you win!' : 'Checkmate — you lost.';
  if (game.status === 'resign') return won ? `${opponent} resigned — you win!` : 'You resigned.';
  if (game.status === 'outoftime') return won ? `${opponent} ran out of time — you win!` : 'You ran out of time.';
  if (game.status === 'timeout') return won ? `${opponent} left the game — you win!` : 'You left the game.';
  if (game.status === 'cheat') return 'Game voided by Lichess fair-play detection.';
  return won ? 'You win.' : 'You lost.';
}

export function formatClock(milliseconds) {
  if (typeof milliseconds !== 'number') return '--:--';
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

export function describeOpponent(game) {
  if (!game) return '';
  const { name, rating, title, isAi } = game.opponent || {};
  const label = [title, name].filter(Boolean).join(' ');
  if (isAi) return `${label} (Lichess computer)`;
  return rating ? `${label} (${rating})` : label || 'Anonymous';
}
