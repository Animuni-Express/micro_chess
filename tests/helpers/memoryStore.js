// In-memory stand-in for supabase/functions/lichess/store.js, mirroring the
// semantics of the SQL functions in
// supabase/migrations/20260804120000_lichess_relay.sql.

export function createMemoryStore({ now = () => Date.now() } = {}) {
  const seats = new Map();
  const games = new Map();

  function leaseUntil(seconds) {
    return new Date(now() + Math.max(30, seconds) * 1000).toISOString();
  }

  function expired(value) {
    return !value || Date.parse(value) < now();
  }

  return {
    seatsMap: seats,
    gamesMap: games,

    async syncSeats(slots) {
      for (const slot of slots) {
        const existing = seats.get(slot.seat_id);
        if (existing && existing.token_fingerprint !== slot.fingerprint) seats.delete(slot.seat_id);
        if (!seats.has(slot.seat_id)) {
          seats.set(slot.seat_id, {
            seat_id: slot.seat_id,
            token_fingerprint: slot.fingerprint,
            lichess_username: null,
            status: 'idle',
            guest_id: null,
            secret_hash: null,
            game_id: null,
            lease_expires_at: null,
            cooldown_until: null,
            updated_at: new Date(now()).toISOString(),
          });
        }
      }
      const keep = new Set(slots.map((slot) => slot.seat_id));
      for (const seatId of [...seats.keys()]) if (!keep.has(seatId)) seats.delete(seatId);
    },

    async claimSeat(guestId, secretHash, leaseSeconds) {
      let seat = [...seats.values()].find(
        (candidate) =>
          candidate.guest_id === guestId &&
          candidate.secret_hash === secretHash &&
          (candidate.status === 'seeking' || candidate.status === 'playing'),
      );
      if (!seat) {
        seat = [...seats.values()].find(
          (candidate) =>
            candidate.status === 'idle' && expired(candidate.lease_expires_at) && expired(candidate.cooldown_until),
        );
      }
      if (!seat) return null;
      seat.guest_id = guestId;
      seat.secret_hash = secretHash;
      seat.status = seat.status === 'playing' ? 'playing' : 'seeking';
      seat.lease_expires_at = leaseUntil(leaseSeconds);
      return { ...seat };
    },

    async touchSeat(seatId, guestId, leaseSeconds) {
      const seat = seats.get(seatId);
      if (seat && seat.guest_id === guestId) seat.lease_expires_at = leaseUntil(leaseSeconds);
    },

    async releaseSeat(seatId, guestId) {
      const seat = seats.get(seatId);
      if (!seat) return;
      if (guestId && seat.guest_id !== guestId) return;
      Object.assign(seat, {
        status: 'idle',
        guest_id: null,
        secret_hash: null,
        game_id: null,
        lease_expires_at: null,
      });
    },

    async cooldownSeat(seatId, seconds) {
      const seat = seats.get(seatId);
      if (seat) seat.cooldown_until = new Date(now() + Math.max(1, seconds) * 1000).toISOString();
    },

    async expireSeats() {
      const out = [];
      for (const seat of seats.values()) {
        if (['seeking', 'playing', 'reaping'].includes(seat.status) && seat.lease_expires_at && expired(seat.lease_expires_at)) {
          out.push({ seat_id: seat.seat_id, game_id: seat.game_id, guest_id: seat.guest_id });
          seat.status = 'reaping';
          seat.lease_expires_at = new Date(now() + 120000).toISOString();
        }
      }
      return out;
    },

    async attachGame(seatId, guestId, secretHash, leaseSeconds, game) {
      const existing = games.get(game.game_id);
      if (existing) {
        if (existing.guest_id !== guestId || existing.secret_hash !== secretHash) {
          throw new Error('That Lichess game is already attached to another player');
        }
        existing.seat_id = seatId;
        existing.last_sync_at = new Date(now()).toISOString();
      } else {
        games.set(game.game_id, {
          ...game,
          seat_id: seatId,
          guest_id: guestId,
          secret_hash: secretHash,
          draw_offer_by: null,
          created_at: new Date(now()).toISOString(),
          updated_at: new Date(now()).toISOString(),
          last_sync_at: new Date(now()).toISOString(),
        });
      }
      const seat = seats.get(seatId);
      if (seat) {
        seat.status = 'playing';
        seat.game_id = game.game_id;
        seat.lease_expires_at = leaseUntil(leaseSeconds);
      }
      return { ...games.get(game.game_id) };
    },

    async setSeatUsername(seatId, username) {
      const seat = seats.get(seatId);
      if (seat) seat.lichess_username = username;
    },

    async seats() {
      return [...seats.values()].map((seat) => ({ ...seat }));
    },

    async seatForGuest(guestId, secretHash) {
      const seat = [...seats.values()].find(
        (candidate) => candidate.guest_id === guestId && candidate.secret_hash === secretHash,
      );
      return seat ? { ...seat } : null;
    },

    async gameForGuest(gameId, guestId, secretHash) {
      const game = games.get(gameId);
      if (!game || game.guest_id !== guestId || game.secret_hash !== secretHash) return null;
      return { ...game };
    },

    async activeGameForGuest(guestId, secretHash) {
      const game = [...games.values()]
        .filter((candidate) => candidate.guest_id === guestId && candidate.secret_hash === secretHash && !candidate.finished)
        .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0];
      return game ? { ...game } : null;
    },

    async gameExists(gameId) {
      return games.has(gameId);
    },

    async updateGame(gameId, patch) {
      const game = games.get(gameId);
      if (!game) return null;
      Object.assign(game, patch, { updated_at: new Date(now()).toISOString() });
      return { ...game };
    },
  };
}
