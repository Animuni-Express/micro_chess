import { invokeEdgeFunction } from '../multiplayer/client';

export function lichess(action, payload = {}) {
  return invokeEdgeFunction('lichess', action, payload);
}

export const relayStatus = () => lichess('status');
export const activeRelayGame = () => lichess('active_game');
export const findLichessOpponent = (timeControl) => lichess('find_opponent', { timeControl });
export const cancelLichessSearch = () => lichess('cancel_search');

// `wait` turns this into a long poll: the Edge Function holds the Lichess board
// stream open until the opponent moves (or ~20s passes), so a move lands here
// almost immediately without the browser polling in a tight loop.
export const readLichessGame = (gameId, { wait = false, sinceMoveCount } = {}) =>
  lichess('get_game', { gameId, wait, sinceMoveCount });

export const sendLichessMove = (gameId, from, to, promotion) =>
  lichess('submit_move', { gameId, from, to, promotion: promotion || null });

export const lichessGameAction = (action, gameId) => lichess(action, { gameId });
