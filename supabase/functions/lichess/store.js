// Supabase-backed store for the Lichess relay. Deliberately thin: everything
// that needs atomicity (seat leasing, attaching a game to a seat, reaping
// abandoned seats) lives in the SQL functions from
// supabase/migrations/20260804120000_lichess_relay.sql, so each method here is a
// single call. tests/lichessRelay.test.js swaps in an in-memory implementation of
// this same interface.

const GAME_COLUMNS = '*';

function unwrap(result, fallbackMessage) {
  if (result.error) throw new Error(result.error.message || fallbackMessage);
  return result.data;
}

export function createStore(admin) {
  async function rpc(name, args) {
    return unwrap(await admin.rpc(name, args), `${name} failed`);
  }

  return {
    async syncSeats(slots) {
      await rpc('lichess_sync_seats', { p_slots: slots });
    },

    async claimSeat(guestId, secretHash, leaseSeconds) {
      return (
        (await rpc('lichess_claim_seat', {
          p_guest_id: guestId,
          p_secret_hash: secretHash,
          p_lease_seconds: leaseSeconds,
        })) || null
      );
    },

    async touchSeat(seatId, guestId, leaseSeconds) {
      await rpc('lichess_touch_seat', { p_seat_id: seatId, p_guest_id: guestId, p_lease_seconds: leaseSeconds });
    },

    async releaseSeat(seatId, guestId) {
      await rpc('lichess_release_seat', { p_seat_id: seatId, p_guest_id: guestId ?? null });
    },

    async cooldownSeat(seatId, seconds) {
      await rpc('lichess_cooldown_seat', { p_seat_id: seatId, p_seconds: Math.round(seconds) });
    },

    async expireSeats() {
      return (await rpc('lichess_expire_seats')) || [];
    },

    async attachGame(seatId, guestId, secretHash, leaseSeconds, game) {
      return rpc('lichess_attach_game', {
        p_seat_id: seatId,
        p_guest_id: guestId,
        p_secret_hash: secretHash,
        p_lease_seconds: leaseSeconds,
        p_game: game,
      });
    },

    async setSeatUsername(seatId, username) {
      unwrap(
        await admin.from('lichess_seats').update({ lichess_username: username }).eq('seat_id', seatId),
        'Unable to record relay account name',
      );
    },

    async seats() {
      return unwrap(await admin.from('lichess_seats').select('*').order('seat_id'), 'Unable to read relay seats') || [];
    },

    async seatForGuest(guestId, secretHash) {
      return (
        unwrap(
          await admin
            .from('lichess_seats')
            .select('*')
            .eq('guest_id', guestId)
            .eq('secret_hash', secretHash)
            .limit(1)
            .maybeSingle(),
          'Unable to read relay seat',
        ) || null
      );
    },

    async gameForGuest(gameId, guestId, secretHash) {
      if (!gameId) return null;
      return (
        unwrap(
          await admin
            .from('lichess_games')
            .select(GAME_COLUMNS)
            .eq('game_id', gameId)
            .eq('guest_id', guestId)
            .eq('secret_hash', secretHash)
            .maybeSingle(),
          'Unable to read game',
        ) || null
      );
    },

    async activeGameForGuest(guestId, secretHash) {
      const rows = unwrap(
        await admin
          .from('lichess_games')
          .select(GAME_COLUMNS)
          .eq('guest_id', guestId)
          .eq('secret_hash', secretHash)
          .eq('finished', false)
          .order('updated_at', { ascending: false })
          .limit(1),
        'Unable to read active game',
      );
      return (rows || [])[0] || null;
    },

    async gameExists(gameId) {
      const row = unwrap(
        await admin.from('lichess_games').select('game_id').eq('game_id', gameId).maybeSingle(),
        'Unable to check game',
      );
      return !!row;
    },

    async updateGame(gameId, patch) {
      return unwrap(
        await admin.from('lichess_games').update(patch).eq('game_id', gameId).select(GAME_COLUMNS).maybeSingle(),
        'Unable to update game',
      );
    },
  };
}
