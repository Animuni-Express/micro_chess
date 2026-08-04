// A fake lichess.org good enough to drive the relay end to end: real ndjson
// streams, real abort semantics, and the same replay-ongoing-games behaviour the
// event stream has, so the relay's seek/long-poll logic is exercised for real.

const encoder = new TextEncoder();

function abortError() {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

function ndjsonResponse({ signal, initialLines = [], onOpen }) {
  let streamController = null;
  const stream = new ReadableStream({
    start(controller) {
      streamController = controller;
      for (const line of initialLines) controller.enqueue(encoder.encode(`${line}\n`));
      if (onOpen) {
        onOpen({
          push(line) {
            try {
              controller.enqueue(encoder.encode(`${line}\n`));
            } catch (_) {
              // Stream already closed by an abort.
            }
          },
        });
      }
    },
  });
  if (signal) {
    const fail = () => {
      try {
        streamController?.error(abortError());
      } catch (_) {
        // Already errored/closed.
      }
    };
    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail);
  }
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

export class FakeLichess {
  constructor(options = {}) {
    this.account = options.account || { id: 'microchessrelay', username: 'MicroChessRelay' };
    this.scopes = options.scopes ?? 'board:play';
    this.tokenKnown = options.tokenKnown ?? true;
    this.games = new Map();
    this.ongoing = new Set();
    this.eventSinks = new Set();
    this.gameSinks = new Map();
    this.calls = [];
    this.seeks = 0;
    this.onSeek = null;
    this.nowPlayingOverride = null;
    this.failNext = null;
    this.fetch = this.fetch.bind(this);
  }

  // ---- test-facing helpers -------------------------------------------------

  startGame({
    gameId = 'game0001',
    relayColor = 'w',
    opponent = { id: 'randomplayer', name: 'RandomPlayer', rating: 1543 },
    clockMs = 300000,
    rated = false,
    moves = '',
  } = {}) {
    const relay = { id: this.account.id, name: this.account.username, rating: 1500 };
    const game = {
      type: 'gameFull',
      id: gameId,
      rated,
      speed: 'blitz',
      clock: { initial: clockMs, increment: 0 },
      initialFen: 'startpos',
      white: relayColor === 'w' ? relay : opponent,
      black: relayColor === 'b' ? relay : opponent,
      state: {
        type: 'gameState',
        moves,
        wtime: clockMs,
        btime: clockMs,
        winc: 0,
        binc: 0,
        status: 'started',
      },
      relayColor,
    };
    this.games.set(gameId, game);
    this.ongoing.add(gameId);
    this.emitEvent({ type: 'gameStart', game: { gameId, color: relayColor === 'w' ? 'white' : 'black', rated } });
    return gameId;
  }

  playMove(gameId, uci) {
    const game = this.games.get(gameId);
    if (!game) throw new Error(`unknown fake game ${gameId}`);
    game.state.moves = game.state.moves ? `${game.state.moves} ${uci}` : uci;
    this.emitGameState(gameId);
  }

  finish(gameId, status, winner = null) {
    const game = this.games.get(gameId);
    if (!game) throw new Error(`unknown fake game ${gameId}`);
    game.state.status = status;
    if (winner) game.state.winner = winner;
    this.ongoing.delete(gameId);
    this.emitGameState(gameId);
  }

  emitEvent(event) {
    const line = JSON.stringify(event);
    for (const sink of this.eventSinks) sink.push(line);
  }

  emitGameState(gameId) {
    const game = this.games.get(gameId);
    const line = JSON.stringify(game.state);
    for (const sink of this.gameSinks.get(gameId) || []) sink.push(line);
  }

  nowPlaying() {
    if (this.nowPlayingOverride) return this.nowPlayingOverride;
    return [...this.ongoing].map((gameId) => {
      const game = this.games.get(gameId);
      return {
        gameId,
        fullId: `${gameId}xxxx`,
        color: game.relayColor === 'w' ? 'white' : 'black',
        rated: game.rated,
        opponent: { username: (game.relayColor === 'w' ? game.black : game.white).name },
      };
    });
  }

  // ---- fetch ---------------------------------------------------------------

  async fetch(url, options = {}) {
    const { pathname } = new URL(url);
    const method = options.method || 'GET';
    this.calls.push({ method, pathname, body: options.body || null });

    if (this.failNext && this.failNext.pathname === pathname) {
      const { status, message, headers } = this.failNext;
      this.failNext = null;
      return json({ error: message || 'nope' }, status, headers || {});
    }

    if (pathname === '/api/account') {
      return json({ id: this.account.id, username: this.account.username });
    }

    if (pathname === '/api/token/test') {
      const token = String(options.body || '');
      if (!this.tokenKnown) return json({ [token]: null });
      return json({ [token]: { userId: this.account.id, scopes: this.scopes, expires: null } });
    }

    if (pathname === '/api/account/playing') {
      return json({ nowPlaying: this.nowPlaying() });
    }

    if (pathname === '/api/stream/event') {
      // Lichess replays games already in progress when the stream opens.
      const replay = [...this.ongoing].map((gameId) => {
        const game = this.games.get(gameId);
        return JSON.stringify({
          type: 'gameStart',
          game: { gameId, color: game.relayColor === 'w' ? 'white' : 'black', rated: game.rated },
        });
      });
      return ndjsonResponse({
        signal: options.signal,
        initialLines: replay,
        onOpen: (sink) => {
          this.eventSinks.add(sink);
          options.signal?.addEventListener('abort', () => this.eventSinks.delete(sink));
        },
      });
    }

    if (pathname === '/api/board/seek') {
      this.seeks += 1;
      const params = new URLSearchParams(String(options.body || ''));
      this.lastSeek = Object.fromEntries(params.entries());
      if (this.onSeek) setTimeout(() => this.onSeek(this.lastSeek), 0);
      return ndjsonResponse({ signal: options.signal });
    }

    const streamMatch = pathname.match(/^\/api\/board\/game\/stream\/(.+)$/);
    if (streamMatch) {
      const gameId = streamMatch[1];
      const game = this.games.get(gameId);
      if (!game) return json({ error: 'No such game' }, 404);
      const { relayColor: _relayColor, ...full } = game;
      return ndjsonResponse({
        signal: options.signal,
        initialLines: [JSON.stringify({ ...full, state: { ...game.state } })],
        onOpen: (sink) => {
          if (!this.gameSinks.has(gameId)) this.gameSinks.set(gameId, new Set());
          this.gameSinks.get(gameId).add(sink);
          options.signal?.addEventListener('abort', () => this.gameSinks.get(gameId)?.delete(sink));
        },
      });
    }

    const boardMatch = pathname.match(/^\/api\/board\/game\/([^/]+)\/(move|resign|abort|draw)(?:\/(.+))?$/);
    if (boardMatch) {
      const [, gameId, verb, argument] = boardMatch;
      const game = this.games.get(gameId);
      if (!game) return json({ error: 'No such game' }, 404);
      if (verb === 'move') {
        this.playMove(gameId, argument);
      } else if (verb === 'resign') {
        this.finish(gameId, 'resign', game.relayColor === 'w' ? 'black' : 'white');
      } else if (verb === 'abort') {
        this.finish(gameId, 'aborted');
      } else if (verb === 'draw') {
        const offering = argument === 'yes';
        game.state[game.relayColor === 'w' ? 'wdraw' : 'bdraw'] = offering;
        this.emitGameState(gameId);
      }
      return json({ ok: true });
    }

    return json({ error: `fake lichess has no route for ${method} ${pathname}` }, 404);
  }
}
