import { createClient } from 'npm:@supabase/supabase-js@2';
import { Chess } from 'npm:chess.js@0.13.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

type Game = Record<string, any>;
type Identity = { guestId: string; guestSecret: string };

function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

function assertIdentity(value: any): asserts value is Identity {
  if (!value?.guestId || !value?.guestSecret || String(value.guestId).length < 12 || String(value.guestSecret).length < 24) {
    throw new Error('Invalid guest identity');
  }
}

function assertTimeControl(value: any) {
  const parsed = Number(value);
  if (parsed !== 300 && parsed !== 600) throw new Error('Unsupported time control');
  return parsed;
}

async function hash(secret: string) {
  const bytes = new TextEncoder().encode(secret);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function roomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (byte) => ROOM_ALPHABET[byte % ROOM_ALPHABET.length]).join('');
}

function playerColor(game: Game, guestId: string, secretHash: string) {
  if (game.white_player_id === guestId && game.white_secret_hash === secretHash) return 'w';
  if (game.black_player_id === guestId && game.black_secret_hash === secretHash) return 'b';
  throw new Error('Game access denied');
}

function publicGame(game: Game) {
  const { white_player_id, black_player_id, white_secret_hash, black_secret_hash, ...safe } = game;
  return safe;
}

function clockRemaining(game: Game, color: 'w' | 'b', now = Date.now()) {
  const value = Number(color === 'w' ? game.white_clock_ms : game.black_clock_ms);
  if (game.status !== 'active' || game.turn !== color || !game.clock_started_at) return value;
  return Math.max(0, value - Math.max(0, now - new Date(game.clock_started_at).getTime()));
}

function chessResult(chess: Chess) {
  if (chess.in_checkmate()) return chess.turn() === 'w' ? 'black_won' : 'white_won';
  if (chess.in_stalemate() || chess.in_draw()) return 'draw';
  return null;
}

async function broadcastGame(admin: any, game: Game) {
  const channel = admin.channel(`micro-chess-game:${game.id}`);
  try {
    const ready = await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), 800);
      channel.subscribe((status: string) => {
        if (status === 'SUBSCRIBED') {
          clearTimeout(timeout);
          resolve(true);
        }
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          clearTimeout(timeout);
          resolve(false);
        }
      });
    });
    if (ready) await channel.send({ type: 'broadcast', event: 'game_update', payload: { game: publicGame(game) } });
  } catch (_) {
    // Polling in the client is the reliability fallback when Realtime is unavailable.
  } finally {
    await admin.removeChannel(channel);
  }
}

async function rawGame(admin: any, gameId: string) {
  const { data, error } = await admin.from('games').select('*').eq('id', gameId).maybeSingle();
  if (error || !data) throw new Error('Game not found');
  return data as Game;
}

async function settleClock(admin: any, game: Game) {
  if (game.status !== 'active' || !game.clock_started_at) return game;
  const left = clockRemaining(game, game.turn);
  if (left > 0) return game;
  const result = game.turn === 'w' ? 'black_won' : 'white_won';
  const patch = {
    [game.turn === 'w' ? 'white_clock_ms' : 'black_clock_ms']: 0,
    status: 'finished', result, clock_started_at: null, draw_offer_by: null, last_activity_at: new Date().toISOString(),
  };
  const { data } = await admin.from('games').update(patch).eq('id', game.id).eq('position_version', game.position_version).select('*').maybeSingle();
  return data || game;
}

async function gameForPlayer(admin: any, identity: Identity, gameId: string) {
  const secretHash = await hash(identity.guestSecret);
  let game = await rawGame(admin, gameId);
  const color = playerColor(game, identity.guestId, secretHash);
  game = await settleClock(admin, game);
  return { game, playerColor: color, secretHash };
}

async function makeRoom(admin: any, identity: Identity, timeControl: number) {
  const secretHash = await hash(identity.guestSecret);
  const creatorColor = crypto.getRandomValues(new Uint8Array(1))[0] % 2 === 0 ? 'w' : 'b';
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const code = roomCode();
    const payload = {
      mode: 'room', room_code: code, time_control: timeControl, status: 'waiting',
      white_player_id: creatorColor === 'w' ? identity.guestId : null,
      black_player_id: creatorColor === 'b' ? identity.guestId : null,
      white_secret_hash: creatorColor === 'w' ? secretHash : null,
      black_secret_hash: creatorColor === 'b' ? secretHash : null,
      white_clock_ms: timeControl * 1000, black_clock_ms: timeControl * 1000,
      expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    };
    const { data, error } = await admin.from('games').insert(payload).select('*').maybeSingle();
    if (data) return { game: publicGame(data), playerColor: creatorColor };
    if (!error?.message?.includes('games_room_code_key')) throw new Error(error?.message || 'Unable to create room');
  }
  throw new Error('Unable to generate a room code. Please try again.');
}

async function matchedGameForPlayer(admin: any, identity: Identity) {
  const secretHash = await hash(identity.guestSecret);
  const { data, error } = await admin.from('games').select('*').or(`white_player_id.eq.${identity.guestId},black_player_id.eq.${identity.guestId}`).in('status', ['active', 'waiting']).order('updated_at', { ascending: false }).limit(1);
  if (error) throw new Error(error.message);
  const game = (data || []).find((candidate: Game) => {
    try { playerColor(candidate, identity.guestId, secretHash); return true; } catch (_) { return false; }
  });
  if (!game) return null;
  return { game: publicGame(game), playerColor: playerColor(game, identity.guestId, secretHash), gameId: game.id };
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const body = await request.json();
    assertIdentity(body);
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRole = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceRole) throw new Error('Multiplayer service is not configured');
    const admin = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false } });
    const identity = { guestId: String(body.guestId), guestSecret: String(body.guestSecret) };

    if (body.action === 'create_room') return respond(await makeRoom(admin, identity, assertTimeControl(body.timeControl)));

    if (body.action === 'join_room') {
      const code = String(body.roomCode || '').toUpperCase();
      if (!/^[A-Z0-9]{6}$/.test(code)) throw new Error('Enter a valid six-character room code');
      const secretHash = await hash(identity.guestSecret);
      const { data, error } = await admin.rpc('join_multiplayer_room', { p_room_code: code, p_guest_id: identity.guestId, p_secret_hash: secretHash });
      if (error || !data) throw new Error(error?.message || 'Unable to join room');
      const result = await gameForPlayer(admin, identity, data);
      await broadcastGame(admin, result.game);
      return respond({ game: publicGame(result.game), playerColor: result.playerColor });
    }

    if (body.action === 'get_game') {
      const result = await gameForPlayer(admin, identity, String(body.gameId));
      return respond({ game: publicGame(result.game), playerColor: result.playerColor, serverNow: new Date().toISOString() });
    }

    // The "COPY LINK" button shares a URL keyed by game id while the room is
    // still 'waiting'. A fresh guest opening that link isn't a recognized
    // player yet, so get_game alone would reject them — this seats them as
    // the second player (or, if they're already seated, just returns the
    // game), the same way join_room does for a typed room code.
    if (body.action === 'join_by_id') {
      const gameId = String(body.gameId || '');
      const secretHash = await hash(identity.guestSecret);
      const { data, error } = await admin.rpc('join_multiplayer_game_by_id', { p_game_id: gameId, p_guest_id: identity.guestId, p_secret_hash: secretHash });
      if (error || !data) throw new Error(error?.message || 'Unable to join this game');
      const result = await gameForPlayer(admin, identity, data);
      await broadcastGame(admin, result.game);
      return respond({ game: publicGame(result.game), playerColor: result.playerColor });
    }

    if (body.action === 'join_matchmaking') {
      const timeControl = assertTimeControl(body.timeControl);
      const secretHash = await hash(identity.guestSecret);
      const { data, error } = await admin.rpc('queue_multiplayer_player', { p_guest_id: identity.guestId, p_secret_hash: secretHash, p_time_control: timeControl });
      if (error) throw new Error(error.message);
      if (!data) return respond({ queued: true });
      const result = await gameForPlayer(admin, identity, data);
      await broadcastGame(admin, result.game);
      return respond({ gameId: data, game: publicGame(result.game), playerColor: result.playerColor });
    }

    if (body.action === 'matchmaking_status') return respond((await matchedGameForPlayer(admin, identity)) || { queued: true });

    if (body.action === 'leave_matchmaking') {
      const secretHash = await hash(identity.guestSecret);
      await admin.from('matchmaking_queue').delete().eq('guest_id', identity.guestId).eq('secret_hash', secretHash);
      return respond({ left: true });
    }

    const result = await gameForPlayer(admin, identity, String(body.gameId));
    const { game, playerColor: color } = result;
    if (game.status !== 'active' && body.action !== 'accept_draw') throw new Error('This game is no longer active');

    if (body.action === 'submit_move') {
      const expectedVersion = Number(body.expectedVersion);
      if (!Number.isInteger(expectedVersion) || expectedVersion !== game.position_version) throw new Error('The board changed. Reloading the latest position.');
      if (game.turn !== color) throw new Error('It is not your turn');
      const remaining = clockRemaining(game, color);
      if (remaining <= 0) {
        const timedOut = await settleClock(admin, game);
        await broadcastGame(admin, timedOut);
        throw new Error('Your clock has expired');
      }
      const from = String(body.from || '');
      const to = String(body.to || '');
      const promotion = body.promotion ? String(body.promotion) : undefined;
      if (!/^[a-h][1-8]$/.test(from) || !/^[a-h][1-8]$/.test(to) || (promotion && !/^[qrbn]$/.test(promotion))) throw new Error('Invalid move');
      const chess = new Chess(game.current_fen || STARTING_FEN);
      const move = chess.move({ from, to, promotion });
      if (!move) throw new Error('Illegal move');
      const resultName = chessResult(chess);
      const now = new Date().toISOString();
      const patch: Record<string, unknown> = {
        current_fen: chess.fen(), turn: chess.turn(), position_version: game.position_version + 1,
        draw_offer_by: null, last_activity_at: now,
        white_clock_ms: color === 'w' ? remaining : game.white_clock_ms,
        black_clock_ms: color === 'b' ? remaining : game.black_clock_ms,
        clock_started_at: resultName ? null : now,
        status: resultName ? 'finished' : 'active', result: resultName,
      };
      const { data: updated, error } = await admin.from('games').update(patch).eq('id', game.id).eq('position_version', expectedVersion).eq('status', 'active').select('*').maybeSingle();
      if (error || !updated) throw new Error('The board changed. Reloading the latest position.');
      await admin.from('moves').insert({ game_id: game.id, move_number: expectedVersion + 1, player_color: color, from_square: from, to_square: to, promotion: promotion || null, san: move.san, fen_after: chess.fen() });
      await broadcastGame(admin, updated);
      return respond({ game: publicGame(updated), playerColor: color });
    }

    let patch: Record<string, unknown>;
    if (body.action === 'resign') {
      patch = { status: 'finished', result: color === 'w' ? 'black_won' : 'white_won', clock_started_at: null, draw_offer_by: null, last_activity_at: new Date().toISOString() };
    } else if (body.action === 'offer_draw') {
      patch = { draw_offer_by: color, last_activity_at: new Date().toISOString() };
    } else if (body.action === 'decline_draw') {
      patch = { draw_offer_by: null, last_activity_at: new Date().toISOString() };
    } else if (body.action === 'accept_draw') {
      if (!game.draw_offer_by || game.draw_offer_by === color) throw new Error('There is no opponent draw offer');
      patch = { status: 'finished', result: 'draw', clock_started_at: null, draw_offer_by: null, last_activity_at: new Date().toISOString() };
    } else {
      throw new Error('Unknown multiplayer action');
    }
    const { data: updated, error } = await admin.from('games').update(patch).eq('id', game.id).eq('position_version', game.position_version).select('*').maybeSingle();
    if (error || !updated) throw new Error(error?.message || 'Unable to update game');
    await broadcastGame(admin, updated);
    return respond({ game: publicGame(updated), playerColor: color });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Multiplayer request failed';
    console.error(message);
    return respond({ error: message }, 400);
  }
});
