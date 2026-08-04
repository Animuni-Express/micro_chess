// Relay orchestration: turns anonymous Micro Chess guests into Lichess board-API
// players on shared relay accounts.
//
// One Lichess token == one seat == at most one live relayed game. A guest leases
// a seat, the relay posts a casual seek to the public Lichess pool on that
// account, and whichever real Lichess player accepts becomes their opponent. The
// guest never sees the token and Lichess never sees the guest — only the relay
// account plays.
//
// Everything here is injected (api, store, clock) so tests can drive the whole
// flow against a fake Lichess and an in-memory store.

import { LichessError } from './lichess_api.js';

export const TIME_CONTROLS = [300, 600];
export const SEEK_LEASE_SECONDS = 90;
const MAX_REAPS_PER_REQUEST = 3;

export const DEFAULT_CONFIG = {
  seekIncrementSeconds: 0,
  seekHoldMs: 20000,
  streamHoldMs: 20000,
  seatLeaseSeconds: 600,
};

export class RelayError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'RelayError';
    this.status = status;
  }
}

function clamp(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function resolveConfig(env = {}) {
  return {
    seekIncrementSeconds: clamp(env.LICHESS_SEEK_INCREMENT, 0, 60, DEFAULT_CONFIG.seekIncrementSeconds),
    seekHoldMs: clamp(env.LICHESS_SEEK_HOLD_MS, 3000, 55000, DEFAULT_CONFIG.seekHoldMs),
    streamHoldMs: clamp(env.LICHESS_STREAM_HOLD_MS, 0, 55000, DEFAULT_CONFIG.streamHoldMs),
    seatLeaseSeconds: clamp(
      env.LICHESS_SEAT_LEASE_MINUTES ? Number(env.LICHESS_SEAT_LEASE_MINUTES) * 60 : undefined,
      60,
      3600,
      DEFAULT_CONFIG.seatLeaseSeconds,
    ),
  };
}

// LICHESS_TOKENS is comma-separated; LICHESS_API_TOKEN / LICHESS_TOKEN are
// single-token aliases so a one-account setup needs no list syntax.
export function readTokens(env = {}) {
  const raw = env.LICHESS_TOKENS || env.LICHESS_API_TOKEN || env.LICHESS_TOKEN || '';
  const seen = new Set();
  return String(raw)
    .split(/[,\s]+/)
    .map((token) => token.trim())
    .filter((token) => {
      if (!token || seen.has(token)) return false;
      seen.add(token);
      return true;
    });
}

export async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function assertIdentity(value) {
  const guestId = String(value?.guestId || '');
  const guestSecret = String(value?.guestSecret || '');
  if (guestId.length < 12 || guestSecret.length < 24) throw new RelayError('Invalid guest identity');
  return { guestId, guestSecret };
}

export function assertTimeControl(value) {
  const parsed = Number(value);
  if (!TIME_CONTROLS.includes(parsed)) throw new RelayError('Unsupported time control');
  return parsed;
}

export function uciFromMove(from, to, promotion) {
  const origin = String(from || '').toLowerCase();
  const target = String(to || '').toLowerCase();
  const promote = promotion ? String(promotion).toLowerCase() : '';
  if (!/^[a-h][1-8]$/.test(origin) || !/^[a-h][1-8]$/.test(target)) throw new RelayError('Invalid move');
  if (promote && !/^[qrbn]$/.test(promote)) throw new RelayError('Invalid promotion piece');
  return `${origin}${target}${promote}`;
}

function snapshotPatch(snapshot, timestamp) {
  return {
    moves: snapshot.moves,
    move_count: snapshot.moveCount,
    status: snapshot.status,
    winner: snapshot.winner,
    white_clock_ms: snapshot.whiteClockMs,
    black_clock_ms: snapshot.blackClockMs,
    draw_offer_by: snapshot.drawOfferBy,
    finished: snapshot.finished,
    opponent_name: snapshot.opponentName,
    opponent_rating: snapshot.opponentRating,
    opponent_title: snapshot.opponentTitle,
    opponent_is_ai: snapshot.opponentIsAi,
    rated: snapshot.rated,
    speed: snapshot.speed,
    initial_clock_ms: snapshot.initialClockMs,
    increment_ms: snapshot.incrementMs,
    initial_fen: snapshot.initialFen,
    last_sync_at: timestamp,
  };
}

function attachPayload(snapshot) {
  return {
    game_id: snapshot.gameId,
    color: snapshot.color,
    opponent_name: snapshot.opponentName,
    opponent_rating: snapshot.opponentRating,
    opponent_title: snapshot.opponentTitle,
    opponent_is_ai: snapshot.opponentIsAi,
    rated: snapshot.rated,
    speed: snapshot.speed,
    initial_clock_ms: snapshot.initialClockMs,
    increment_ms: snapshot.incrementMs,
    initial_fen: snapshot.initialFen,
    moves: snapshot.moves,
    move_count: snapshot.moveCount,
    status: snapshot.status,
    winner: snapshot.winner,
    white_clock_ms: snapshot.whiteClockMs,
    black_clock_ms: snapshot.blackClockMs,
    finished: snapshot.finished,
  };
}

// Never exposes guest_id / secret_hash / seat_id: the browser only needs the
// board state and who it is playing.
export function publicGame(row) {
  if (!row) return null;
  return {
    gameId: row.game_id,
    color: row.color,
    opponent: {
      name: row.opponent_name || 'Anonymous',
      rating: row.opponent_rating ?? null,
      title: row.opponent_title || null,
      isAi: !!row.opponent_is_ai,
    },
    rated: !!row.rated,
    speed: row.speed || null,
    initialClockMs: row.initial_clock_ms ?? null,
    incrementMs: row.increment_ms ?? 0,
    initialFen: row.initial_fen || 'startpos',
    moves: row.moves || '',
    moveCount: row.move_count ?? 0,
    status: row.status,
    winner: row.winner || null,
    whiteClockMs: row.white_clock_ms ?? null,
    blackClockMs: row.black_clock_ms ?? null,
    drawOfferBy: row.draw_offer_by || null,
    finished: !!row.finished,
    lichessUrl: `https://lichess.org/${row.game_id}`,
    lastSyncAt: row.last_sync_at || null,
  };
}

export function createRelay({ api, store, tokens = [], config = DEFAULT_CONFIG, now = () => Date.now(), logger = console }) {
  const settings = { ...DEFAULT_CONFIG, ...config };
  let slots = null;
  let initPromise = null;

  async function init() {
    if (!initPromise) {
      initPromise = (async () => {
        slots = await Promise.all(
          tokens.map(async (token, index) => ({
            seatId: `slot-${index}`,
            token,
            fingerprint: (await sha256Hex(token)).slice(0, 32),
            userId: null,
            username: null,
          })),
        );
        await store.syncSeats(slots.map((slot) => ({ seat_id: slot.seatId, fingerprint: slot.fingerprint })));
      })().catch((error) => {
        initPromise = null;
        throw error;
      });
    }
    await initPromise;
    return slots;
  }

  // Resolves (and caches) which Lichess account a slot's token belongs to. The
  // account id is what tells us which side of a relayed game is "us".
  async function identify(slot) {
    if (!slot.userId) {
      const account = await api.account(slot.token);
      slot.userId = account.id;
      slot.username = account.username;
      await store.setSeatUsername(slot.seatId, account.username);
    }
    return slot;
  }

  async function slotForSeat(seatId) {
    const all = await init();
    const slot = all.find((candidate) => candidate.seatId === seatId);
    if (!slot) throw new RelayError('This game was created with a Lichess token that is no longer configured', 409);
    return identify(slot);
  }

  function timestamp() {
    return new Date(now()).toISOString();
  }

  async function finishSeat(row) {
    if (row.seat_id) await store.releaseSeat(row.seat_id, row.guest_id);
  }

  async function syncGame(row, { holdMs = 0, sinceMoveCount } = {}) {
    const slot = await slotForSeat(row.seat_id);
    const snapshot = await api.readGame(slot.token, row.game_id, {
      holdMs,
      sinceMoveCount: Number.isInteger(sinceMoveCount) ? sinceMoveCount : row.move_count,
      userId: slot.userId,
    });
    const updated = await store.updateGame(row.game_id, snapshotPatch(snapshot, timestamp()));
    if (snapshot.finished) await finishSeat(row);
    else if (row.seat_id) await store.touchSeat(row.seat_id, row.guest_id, settings.seatLeaseSeconds);
    return updated;
  }

  // Reading Lichess can fail transiently (rate limit, blip). For read paths that
  // is not fatal: hand back the last known position with a warning so the board
  // stays usable instead of erroring out.
  async function syncGameSoftly(row, options) {
    try {
      return { row: await syncGame(row, options), warning: null };
    } catch (error) {
      if (error instanceof LichessError && error.rateLimited && row.seat_id) {
        await store.cooldownSeat(row.seat_id, error.retryAfterSeconds);
      }
      logger.error?.(`lichess sync failed for ${row.game_id}: ${error.message}`);
      return { row, warning: error.message };
    }
  }

  async function ownedGame(gameId, guestId, secretHash) {
    const row = await store.gameForGuest(String(gameId || ''), guestId, secretHash);
    if (!row) throw new RelayError('Game access denied', 403);
    return row;
  }

  // Hands abandoned seats back to the pool. A guest who closes the tab mid-game
  // would otherwise leave a live Lichess game hanging (bad for the opponent) and
  // the account occupied, so the game is aborted/resigned first — and the seat is
  // only released once that succeeded.
  async function reapAbandonedSeats() {
    let expired = [];
    try {
      expired = (await store.expireSeats()) || [];
    } catch (error) {
      logger.error?.(`lichess seat reap query failed: ${error.message}`);
      return;
    }
    for (const entry of expired.slice(0, MAX_REAPS_PER_REQUEST)) {
      try {
        if (entry.game_id) {
          const slot = await slotForSeat(entry.seat_id);
          const snapshot = await api.readGame(slot.token, entry.game_id, { userId: slot.userId });
          if (!snapshot.finished) {
            if (snapshot.moveCount < 2) await api.abort(slot.token, entry.game_id);
            else await api.resign(slot.token, entry.game_id);
          }
          await store.updateGame(entry.game_id, {
            finished: true,
            status: snapshot.finished ? snapshot.status : snapshot.moveCount < 2 ? 'aborted' : 'resign',
            winner: snapshot.finished ? snapshot.winner : snapshot.moveCount < 2 ? null : snapshot.color === 'w' ? 'b' : 'w',
            last_sync_at: timestamp(),
          });
        }
        await store.releaseSeat(entry.seat_id, null);
      } catch (error) {
        // Leave the seat in 'reaping'; its short lease brings it back here
        // shortly. Releasing it now could start a second game on an account
        // that still has a live one.
        logger.error?.(`could not reap lichess seat ${entry.seat_id}: ${error.message}`);
      }
    }
  }

  async function attachGame(seat, identityRow, snapshot) {
    const row = await store.attachGame(
      seat.seat_id,
      identityRow.guestId,
      identityRow.secretHash,
      settings.seatLeaseSeconds,
      attachPayload(snapshot),
    );
    return row;
  }

  async function findOpponent(identityRow, timeControl) {
    await reapAbandonedSeats();

    const resumable = await store.activeGameForGuest(identityRow.guestId, identityRow.secretHash);
    if (resumable) {
      const { row, warning } = await syncGameSoftly(resumable);
      if (!row.finished) return { game: publicGame(row), resumed: true, warning };
    }

    const all = await init();
    if (!all.length) {
      throw new RelayError(
        'Lichess play is not configured on this server (no LICHESS_TOKENS secret). See DEPLOY.md.',
        503,
      );
    }

    const seat = await store.claimSeat(identityRow.guestId, identityRow.secretHash, SEEK_LEASE_SECONDS);
    if (!seat) {
      return {
        busy: true,
        seats: all.length,
        message: `All ${all.length} Lichess relay seat${all.length === 1 ? '' : 's'} are in use right now. Try again shortly, or play a Micro Chess opponent instead.`,
      };
    }

    let slot;
    try {
      slot = await slotForSeat(seat.seat_id);
    } catch (error) {
      await store.releaseSeat(seat.seat_id, identityRow.guestId);
      throw error;
    }

    try {
      // A seek accepted just as the previous call timed out leaves an ongoing
      // game on the account with nobody attached: adopt it instead of seeking
      // again, which would put the account in two games at once.
      const orphan = await findOrphanGame(slot);
      if (orphan) {
        const snapshot = await api.readGame(slot.token, orphan, { userId: slot.userId });
        return { game: publicGame(await attachGame(seat, identityRow, snapshot)) };
      }

      const result = await api.seekAndWait(slot.token, {
        minutes: timeControl / 60,
        incrementSeconds: settings.seekIncrementSeconds,
        holdMs: settings.seekHoldMs,
        userId: slot.userId,
        isClaimable: async (gameId) => !(await store.gameExists(gameId)),
      });

      if (result.gameId) {
        const snapshot = result.game || (await api.readGame(slot.token, result.gameId, { userId: slot.userId }));
        return { game: publicGame(await attachGame(seat, identityRow, snapshot)) };
      }

      await store.touchSeat(seat.seat_id, identityRow.guestId, SEEK_LEASE_SECONDS);
      return { searching: true, seatId: seat.seat_id, relayAccount: slot.username };
    } catch (error) {
      if (error instanceof LichessError && error.rateLimited) {
        await store.cooldownSeat(seat.seat_id, error.retryAfterSeconds);
      }
      await store.releaseSeat(seat.seat_id, identityRow.guestId);
      throw error;
    }
  }

  async function findOrphanGame(slot) {
    const playing = await api.nowPlaying(slot.token);
    for (const game of playing) {
      const gameId = game.gameId || game.fullId?.slice(0, 8);
      if (!gameId || game.rated || game.opponent?.ai) continue;
      if (await store.gameExists(gameId)) continue;
      return gameId;
    }
    return null;
  }

  async function relayGameAction(identityRow, body, run) {
    const row = await ownedGame(body.gameId, identityRow.guestId, identityRow.secretHash);
    if (row.finished) throw new RelayError('This game is already over');
    const slot = await slotForSeat(row.seat_id);
    await run(slot, row);
    const { row: synced, warning } = await syncGameSoftly(row, { sinceMoveCount: -1 });
    return { game: publicGame(synced), warning };
  }

  // `probe` forces a fresh token check against Lichess. Without it, a seat whose
  // account name is already recorded is reported straight from the database: the
  // lobby polls this on every visit and must not spend Lichess rate limit (or add
  // latency) re-verifying a token that already worked.
  async function status({ probe = false } = {}) {
    const all = await init();
    const seats = await store.seats();
    const seatById = new Map(seats.map((seat) => [seat.seat_id, seat]));
    const accounts = [];
    for (const slot of all) {
      const known = seatById.get(slot.seatId)?.lichess_username || slot.username || null;
      const entry = { seatId: slot.seatId, username: known, scopes: [], error: null };
      if (!probe && known) {
        entry.tokenValid = true;
        accounts.push(entry);
        continue;
      }
      try {
        const scopeInfo = await api.tokenScopes(slot.token);
        entry.scopes = scopeInfo.scopes;
        entry.tokenValid = scopeInfo.valid;
        if (!scopeInfo.valid) entry.error = 'Lichess does not recognise this token (revoked or mistyped).';
        else if (!scopeInfo.scopes.includes('board:play')) {
          entry.error = 'Token is missing the required "board:play" scope.';
        } else {
          await identify(slot);
          entry.username = slot.username;
        }
      } catch (error) {
        entry.error = error.message;
      }
      accounts.push(entry);
    }
    const free = seats.filter((seat) => seat.status === 'idle').length;
    return {
      configured: all.length > 0,
      seatCount: all.length,
      freeSeats: all.length ? free : 0,
      rated: false,
      timeControls: TIME_CONTROLS,
      accounts,
      seats: seats.map((seat) => ({
        seatId: seat.seat_id,
        status: seat.status,
        username: seat.lichess_username || null,
        busyUntil: seat.lease_expires_at || null,
      })),
    };
  }

  async function handle(body = {}) {
    const action = String(body.action || '');
    if (action === 'status') return status({ probe: body.probe === true });

    const { guestId, guestSecret } = assertIdentity(body);
    const secretHash = await sha256Hex(guestSecret);
    const identityRow = { guestId, secretHash };

    if (action === 'find_opponent') return findOpponent(identityRow, assertTimeControl(body.timeControl));

    if (action === 'active_game') {
      const row = await store.activeGameForGuest(guestId, secretHash);
      if (!row) return { game: null };
      const { row: synced, warning } = await syncGameSoftly(row);
      return { game: publicGame(synced), warning };
    }

    if (action === 'cancel_search') {
      const seat = await store.seatForGuest(guestId, secretHash);
      if (seat && seat.status === 'seeking') await store.releaseSeat(seat.seat_id, guestId);
      return { cancelled: true };
    }

    if (action === 'get_game') {
      const row = await ownedGame(body.gameId, guestId, secretHash);
      if (row.finished) return { game: publicGame(row), serverNow: timestamp() };
      const wantsWait = body.wait === true || body.wait === 'true';
      const { row: synced, warning } = await syncGameSoftly(row, {
        holdMs: wantsWait ? settings.streamHoldMs : 0,
        sinceMoveCount: Number.isInteger(body.sinceMoveCount) ? body.sinceMoveCount : row.move_count,
      });
      return { game: publicGame(synced), warning, serverNow: timestamp() };
    }

    if (action === 'submit_move') {
      const uci = uciFromMove(body.from, body.to, body.promotion);
      return relayGameAction(identityRow, body, (slot, row) => api.move(slot.token, row.game_id, uci));
    }

    if (action === 'resign') {
      return relayGameAction(identityRow, body, (slot, row) => api.resign(slot.token, row.game_id));
    }

    if (action === 'abort') {
      return relayGameAction(identityRow, body, (slot, row) => api.abort(slot.token, row.game_id));
    }

    if (action === 'offer_draw' || action === 'accept_draw') {
      return relayGameAction(identityRow, body, (slot, row) => api.draw(slot.token, row.game_id, true));
    }

    if (action === 'decline_draw') {
      return relayGameAction(identityRow, body, (slot, row) => api.draw(slot.token, row.game_id, false));
    }

    throw new RelayError('Unknown Lichess relay action');
  }

  return { handle, status, init };
}
