// Lichess HTTP layer for the relay Edge Function.
//
// Plain JS (not .ts) on purpose: Deno type-checks it loosely via allowJs, and
// jest can import it directly so the streaming/seek logic is covered by tests
// against a fake Lichess (see tests/lichessRelay.test.js). `fetch` is injected
// for the same reason — nothing here reaches the network on its own.

export const LICHESS_BASE_URL = 'https://lichess.org';

// Lichess answers 429 when a token is used too aggressively and expects a full
// minute of silence before the next request on that account.
export const RATE_LIMIT_COOLDOWN_SECONDS = 60;

export class LichessError extends Error {
  constructor(message, status = 502, options = {}) {
    super(message);
    this.name = 'LichessError';
    this.status = status;
    this.rateLimited = status === 429;
    this.retryAfterSeconds = options.retryAfterSeconds || (status === 429 ? RATE_LIMIT_COOLDOWN_SECONDS : 0);
  }
}

function isAbortError(error) {
  return error?.name === 'AbortError' || error?.name === 'TimeoutError' || /aborted/i.test(error?.message || '');
}

function parseJsonLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch (_) {
    return null;
  }
}

// Lichess ndjson streams: one JSON object per line, blank lines every few
// seconds as keep-alive. Reads with an explicit reader rather than `for await`
// on the body so the same code runs on Deno and on Node under jest.
async function* iterateLines(body) {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        yield buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
      }
    }
    if (buffer) yield buffer;
  } finally {
    try {
      reader.releaseLock();
    } catch (_) {
      // The stream was already cancelled by an abort; nothing to release.
    }
  }
}

function side(player) {
  if (!player) return null;
  if (player.aiLevel) return { name: `Stockfish level ${player.aiLevel}`, isAi: true, rating: null, title: null, id: null };
  return {
    id: (player.id || '').toLowerCase(),
    name: player.name || player.id || 'Anonymous',
    rating: typeof player.rating === 'number' ? player.rating : null,
    title: player.title || null,
    isAi: false,
  };
}

export function countMoves(moves) {
  const trimmed = (moves || '').trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

export function isFinishedStatus(status) {
  return !!status && status !== 'created' && status !== 'started';
}

// Fold a `gameFull` header plus the latest `gameState` into the flat snapshot
// the rest of the relay stores and returns.
export function buildSnapshot(full, state, userId) {
  if (!full) return null;
  const white = side(full.white);
  const black = side(full.black);
  const me = (userId || '').toLowerCase();
  // `me &&` matters: an empty userId must not match an anonymous/AI player's
  // empty id and silently flip which side the relay thinks it is playing.
  const color = me && black?.id && black.id === me ? 'b' : 'w';
  const opponent = color === 'w' ? black : white;
  const latest = state || full.state || {};
  const status = latest.status || 'started';
  return {
    gameId: full.id,
    color,
    opponentName: opponent?.name || 'Anonymous',
    opponentRating: opponent?.rating ?? null,
    opponentTitle: opponent?.title || null,
    opponentIsAi: !!opponent?.isAi,
    rated: !!full.rated,
    speed: full.speed || null,
    initialClockMs: typeof full.clock?.initial === 'number' ? full.clock.initial : null,
    incrementMs: typeof full.clock?.increment === 'number' ? full.clock.increment : 0,
    initialFen: full.initialFen || 'startpos',
    moves: (latest.moves || '').trim(),
    moveCount: countMoves(latest.moves),
    status,
    winner: latest.winner === 'white' ? 'w' : latest.winner === 'black' ? 'b' : null,
    whiteClockMs: typeof latest.wtime === 'number' ? latest.wtime : null,
    blackClockMs: typeof latest.btime === 'number' ? latest.btime : null,
    drawOfferBy: latest.wdraw ? 'w' : latest.bdraw ? 'b' : null,
    finished: isFinishedStatus(status),
  };
}

export function createLichessApi({ fetch: fetchImpl, baseUrl = LICHESS_BASE_URL, now = () => Date.now() } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') throw new Error('createLichessApi requires a fetch implementation');

  async function request(path, { token, method = 'GET', body, signal, accept = 'application/json' } = {}) {
    const headers = { Accept: accept };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    let response;
    try {
      response = await doFetch(`${baseUrl}${path}`, { method, headers, body, signal });
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new LichessError(`Could not reach Lichess (${error?.message || 'network error'})`, 502);
    }
    if (response.ok) return response;

    const retryAfter = Number(response.headers?.get?.('Retry-After')) || 0;
    let detail = '';
    try {
      detail = (await response.text()).slice(0, 300);
    } catch (_) {
      detail = '';
    }
    const parsed = parseJsonLine(detail);
    const message = parsed?.error || detail || response.statusText || 'request failed';
    if (response.status === 401 || response.status === 403) {
      throw new LichessError(
        `Lichess rejected the relay token (${response.status}): ${message}. The token needs the "board:play" scope.`,
        response.status,
      );
    }
    if (response.status === 429) {
      throw new LichessError('Lichess is rate-limiting the relay account. Please try again in a minute.', 429, {
        retryAfterSeconds: retryAfter || RATE_LIMIT_COOLDOWN_SECONDS,
      });
    }
    throw new LichessError(`Lichess ${response.status}: ${message}`, response.status);
  }

  async function json(path, options) {
    const response = await request(path, options);
    return response.json();
  }

  async function account(token) {
    const data = await json('/api/account', { token });
    return { id: (data.id || '').toLowerCase(), username: data.username || data.id, title: data.title || null };
  }

  // POST /api/token/test takes the token in the body, so it reports scopes even
  // for a token too limited to call /api/account. Used by the status action to
  // tell "no board:play scope" apart from "wrong token".
  async function tokenScopes(token) {
    const response = await request('/api/token/test', { method: 'POST', body: token });
    const data = await response.json();
    const entry = data?.[token];
    if (!entry) return { valid: false, scopes: [], userId: null };
    return {
      valid: true,
      userId: entry.userId || null,
      scopes: String(entry.scopes || '').split(',').map((scope) => scope.trim()).filter(Boolean),
      expires: entry.expires || null,
    };
  }

  async function nowPlaying(token) {
    const data = await json('/api/account/playing?nb=10', { token });
    return Array.isArray(data?.nowPlaying) ? data.nowPlaying : [];
  }

  // Reads the board stream for one game. With holdMs > 0 this becomes a
  // long-poll: it keeps the stream open until the move count passes
  // sinceMoveCount (i.e. the opponent moved), the game ends, or the hold
  // elapses. One Lichess request delivers the opponent's move within
  // milliseconds instead of a poll loop hammering the API.
  async function readGame(token, gameId, { holdMs = 0, sinceMoveCount = -1, userId } = {}) {
    const controller = new AbortController();
    const timer = holdMs > 0 ? setTimeout(() => controller.abort(), holdMs) : null;
    let full = null;
    let state = null;
    let snapshot = null;
    try {
      const response = await request(`/api/board/game/stream/${encodeURIComponent(gameId)}`, {
        token,
        signal: controller.signal,
        accept: 'application/x-ndjson',
      });
      for await (const line of iterateLines(response.body)) {
        const event = parseJsonLine(line);
        if (!event) continue;
        if (event.type === 'gameFull') {
          full = event;
          state = event.state || null;
        } else if (event.type === 'gameState') {
          state = event;
        } else {
          continue;
        }
        snapshot = buildSnapshot(full, state, userId);
        if (!snapshot) continue;
        // holdMs <= 0 means "just read the current position": take the first
        // complete snapshot and go, rather than waiting for a change that may
        // never come.
        if (holdMs <= 0 || snapshot.finished || snapshot.moveCount > sinceMoveCount) break;
      }
    } catch (error) {
      if (!isAbortError(error)) throw error;
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
    }
    if (!snapshot) throw new LichessError('Lichess did not return the game state', 502);
    return snapshot;
  }

  // Puts a seek in the public Lichess pool and waits for a real player to take
  // it. POST /api/board/seek is a long-lived request — the seek stays alive only
  // while the connection is open — so this holds it for holdMs and reports
  // `searching` on timeout for the browser to call again.
  async function seekAndWait(token, {
    minutes,
    incrementSeconds = 0,
    holdMs = 20000,
    userId,
    isClaimable = async () => true,
  } = {}) {
    const eventController = new AbortController();
    const seekController = new AbortController();
    let seekFailure = null;

    const eventStream = await request('/api/stream/event', {
      token,
      signal: eventController.signal,
      accept: 'application/x-ndjson',
    });

    const body = new URLSearchParams({
      rated: 'false',
      time: String(minutes),
      increment: String(incrementSeconds),
      variant: 'standard',
      color: 'random',
    }).toString();
    // Deliberately not awaited: the seek request stays open for its lifetime.
    const seekRequest = request('/api/board/seek', {
      token,
      method: 'POST',
      body,
      signal: seekController.signal,
      accept: 'application/x-ndjson',
    })
      .then(async (response) => {
        // Drain so the connection (and therefore the seek) stays alive.
        for await (const _line of iterateLines(response.body)) {
          if (seekController.signal.aborted) break;
        }
      })
      .catch((error) => {
        if (!isAbortError(error)) seekFailure = error;
      });

    const deadline = now() + holdMs;
    const timer = setTimeout(() => eventController.abort(), holdMs);
    let gameId = null;
    try {
      for await (const line of iterateLines(eventStream.body)) {
        if (seekFailure) break;
        const event = parseJsonLine(line);
        if (event?.type === 'gameStart') {
          const game = event.game || {};
          const candidate = game.gameId || game.id;
          // The event stream replays games already in progress on this account
          // when it connects, so skip anything another guest owns. Rated games
          // are never relayed: a shared account must only play casual.
          if (candidate && !game.rated && (await isClaimable(candidate))) {
            gameId = candidate;
            break;
          }
        }
        if (now() >= deadline) break;
      }
    } catch (error) {
      if (!isAbortError(error)) throw error;
    } finally {
      clearTimeout(timer);
      eventController.abort();
      seekController.abort();
      await seekRequest;
    }

    if (seekFailure) throw seekFailure;
    if (!gameId) return { searching: true };
    return { gameId, game: await readGame(token, gameId, { userId }) };
  }

  async function post(token, path) {
    const response = await request(path, { token, method: 'POST' });
    try {
      return await response.json();
    } catch (_) {
      return { ok: true };
    }
  }

  return {
    request,
    account,
    tokenScopes,
    nowPlaying,
    readGame,
    seekAndWait,
    move: (token, gameId, uci) =>
      post(token, `/api/board/game/${encodeURIComponent(gameId)}/move/${encodeURIComponent(uci)}`),
    resign: (token, gameId) => post(token, `/api/board/game/${encodeURIComponent(gameId)}/resign`),
    abort: (token, gameId) => post(token, `/api/board/game/${encodeURIComponent(gameId)}/abort`),
    draw: (token, gameId, accept) =>
      post(token, `/api/board/game/${encodeURIComponent(gameId)}/draw/${accept ? 'yes' : 'no'}`),
  };
}
