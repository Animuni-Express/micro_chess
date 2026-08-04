import { Chess } from 'chess.js';
import {
  applyUciMoves,
  canAbortRelayGame,
  describeOpponent,
  describeRelayResult,
  formatClock,
  isOurTurn,
  positionFromRelay,
  relayClockRemaining,
  relayStartingFen,
} from '../src/core/lichessGame';
import { STARTING_FEN } from '../src/core/onlineGame';

function relayGame(overrides = {}) {
  return {
    gameId: 'abcd1234',
    color: 'w',
    opponent: { name: 'RandomPlayer', rating: 1543, title: null, isAi: false },
    rated: false,
    speed: 'blitz',
    initialClockMs: 300000,
    incrementMs: 0,
    initialFen: 'startpos',
    moves: '',
    moveCount: 0,
    status: 'started',
    winner: null,
    whiteClockMs: 300000,
    blackClockMs: 300000,
    drawOfferBy: null,
    finished: false,
    lastSyncAt: '2026-08-04T12:00:00.000Z',
    ...overrides,
  };
}

describe('relayStartingFen', () => {
  test('maps Lichess "startpos" to a real FEN', () => {
    expect(relayStartingFen('startpos')).toBe(STARTING_FEN);
    expect(relayStartingFen(null)).toBe(STARTING_FEN);
  });

  test('passes a from-position FEN through', () => {
    const fen = '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1';
    expect(relayStartingFen(fen)).toBe(fen);
  });
});

describe('applyUciMoves', () => {
  test('replays a normal opening', () => {
    const chess = applyUciMoves(new Chess(STARTING_FEN), 'e2e4 e7e5 g1f3');
    expect(chess.turn()).toBe('b');
    expect(chess.history()).toEqual(['e4', 'e5', 'Nf3']);
  });

  test('replays castling, given as a king move in UCI', () => {
    const chess = applyUciMoves(new Chess(STARTING_FEN), 'e2e4 e7e5 g1f3 b8c6 f1c4 g8f6 e1g1');
    expect(chess.history().pop()).toBe('O-O');
  });

  test('replays a promotion', () => {
    const chess = applyUciMoves(new Chess('8/4P3/8/8/8/8/8/4K2k w - - 0 1'), 'e7e8q');
    expect(chess.get('e8')).toMatchObject({ type: 'q', color: 'w' });
  });

  test('tolerates an empty move list', () => {
    expect(applyUciMoves(new Chess(STARTING_FEN), '').fen()).toBe(STARTING_FEN);
    expect(applyUciMoves(new Chess(STARTING_FEN), null).fen()).toBe(STARTING_FEN);
  });

  test('throws on a move that cannot be replayed', () => {
    expect(() => applyUciMoves(new Chess(STARTING_FEN), 'e2e5')).toThrow(/cannot replay/);
  });
});

describe('positionFromRelay', () => {
  test('builds the current position', () => {
    const { chess, error } = positionFromRelay(relayGame({ moves: 'e2e4 c7c5', moveCount: 2 }));
    expect(error).toBeNull();
    expect(chess.turn()).toBe('w');
    expect(chess.get('c5')).toMatchObject({ type: 'p', color: 'b' });
  });

  test('reports a replay failure instead of throwing', () => {
    const { chess, error } = positionFromRelay(relayGame({ moves: 'e2e4 h9h1' }));
    expect(error).toMatch(/cannot replay/);
    expect(chess.turn()).toBe('b');
  });

  test('handles a missing game', () => {
    const { chess, error } = positionFromRelay(null);
    expect(error).toBeNull();
    expect(chess.fen()).toBe(STARTING_FEN);
  });
});

describe('isOurTurn', () => {
  test('is true only when the live game is on our colour', () => {
    const game = relayGame({ color: 'w' });
    expect(isOurTurn(game, 'w')).toBe(true);
    expect(isOurTurn(game, 'b')).toBe(false);
    expect(isOurTurn({ ...game, finished: true }, 'w')).toBe(false);
    expect(isOurTurn(null, 'w')).toBe(false);
  });
});

describe('relayClockRemaining', () => {
  const syncedAt = Date.parse('2026-08-04T12:00:00.000Z');

  test('counts down for the side to move', () => {
    const game = relayGame({ moves: 'e2e4', moveCount: 1, whiteClockMs: 200000, blackClockMs: 180000 });
    expect(relayClockRemaining(game, 'b', { now: syncedAt + 5000, turn: 'b' })).toBe(175000);
    // The idle side's clock is frozen.
    expect(relayClockRemaining(game, 'w', { now: syncedAt + 5000, turn: 'b' })).toBe(200000);
  });

  test('does not run before the first move', () => {
    const game = relayGame({ moveCount: 0 });
    expect(relayClockRemaining(game, 'w', { now: syncedAt + 9000, turn: 'w' })).toBe(300000);
  });

  test('freezes once the game is over', () => {
    const game = relayGame({ moveCount: 4, finished: true, whiteClockMs: 120000 });
    expect(relayClockRemaining(game, 'w', { now: syncedAt + 60000, turn: 'w' })).toBe(120000);
  });

  test('never goes negative', () => {
    const game = relayGame({ moveCount: 3, blackClockMs: 1000 });
    expect(relayClockRemaining(game, 'b', { now: syncedAt + 60000, turn: 'b' })).toBe(0);
  });

  test('corrects for a device clock that is ahead of the server', () => {
    const game = relayGame({ moveCount: 1, blackClockMs: 180000 });
    const skewMs = 3600000;
    expect(relayClockRemaining(game, 'b', { now: syncedAt + skewMs + 4000, turn: 'b', skewMs })).toBe(176000);
  });

  test('returns null when Lichess reported no clock (correspondence)', () => {
    const game = relayGame({ whiteClockMs: null });
    expect(relayClockRemaining(game, 'w', { now: syncedAt, turn: 'w' })).toBeNull();
  });
});

describe('describeRelayResult', () => {
  test('describes whose turn it is', () => {
    expect(describeRelayResult(relayGame({ color: 'w' }), 'w')).toBe('Your move');
    expect(describeRelayResult(relayGame({ color: 'w' }), 'b')).toBe('RandomPlayer to move');
  });

  test('describes each finish from our point of view', () => {
    const finished = (overrides) => describeRelayResult(relayGame({ finished: true, ...overrides }), 'w');
    expect(finished({ status: 'mate', winner: 'w' })).toMatch(/you win/i);
    expect(finished({ status: 'mate', winner: 'b' })).toMatch(/you lost/i);
    expect(finished({ status: 'resign', winner: 'w' })).toMatch(/RandomPlayer resigned/);
    expect(finished({ status: 'resign', winner: 'b' })).toBe('You resigned.');
    expect(finished({ status: 'outoftime', winner: 'w' })).toMatch(/ran out of time/);
    expect(finished({ status: 'draw' })).toBe('Game drawn.');
    expect(finished({ status: 'stalemate' })).toBe('Game drawn.');
    expect(finished({ status: 'aborted' })).toMatch(/aborted/);
    expect(finished({ status: 'timeout', winner: 'w' })).toMatch(/left the game/);
  });

  test('handles a missing game', () => {
    expect(describeRelayResult(null, 'w')).toBe('Loading game…');
  });
});

describe('presentation helpers', () => {
  test('canAbortRelayGame only allows aborting in the first move or two', () => {
    expect(canAbortRelayGame(relayGame({ moveCount: 0 }))).toBe(true);
    expect(canAbortRelayGame(relayGame({ moveCount: 1 }))).toBe(true);
    expect(canAbortRelayGame(relayGame({ moveCount: 2 }))).toBe(false);
    expect(canAbortRelayGame(relayGame({ moveCount: 0, finished: true }))).toBe(false);
  });

  test('formatClock renders mm:ss and copes with no clock', () => {
    expect(formatClock(300000)).toBe('05:00');
    expect(formatClock(0)).toBe('00:00');
    expect(formatClock(-500)).toBe('00:00');
    expect(formatClock(null)).toBe('--:--');
  });

  test('describeOpponent shows title, name and rating', () => {
    expect(describeOpponent(relayGame())).toBe('RandomPlayer (1543)');
    expect(describeOpponent(relayGame({ opponent: { name: 'Magnus', rating: 2900, title: 'GM' } }))).toBe('GM Magnus (2900)');
    expect(describeOpponent(relayGame({ opponent: { name: 'Stockfish level 5', isAi: true } }))).toMatch(/computer/);
  });
});
