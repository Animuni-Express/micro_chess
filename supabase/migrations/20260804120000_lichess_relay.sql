-- Lichess relay: lets an anonymous Micro Chess guest play a real Lichess
-- player without a Lichess account of their own.
--
-- The `lichess` Edge Function holds one or more Lichess personal access tokens
-- (LICHESS_TOKENS, see .env.example). Each token is one Lichess account, and an
-- account can only be seeking-or-playing one relayed game at a time, so tokens
-- are modelled as *seats*: a guest leases a seat, the function posts a seek to
-- the Lichess pool on that account, and the resulting game is bound to that one
-- guest. Tokens themselves are never stored here — only a fingerprint, so
-- rotating a token resets its seat instead of silently reusing stale state.

create table if not exists public.lichess_seats (
  seat_id text primary key,
  token_fingerprint text not null,
  lichess_username text,
  status text not null default 'idle' check (status in ('idle', 'seeking', 'playing', 'reaping')),
  guest_id text,
  secret_hash text,
  game_id text,
  lease_expires_at timestamptz,
  -- Set when Lichess answers 429 so the next claim skips this token instead of
  -- hammering a rate-limited account.
  cooldown_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.lichess_games (
  game_id text primary key,
  seat_id text references public.lichess_seats(seat_id) on delete set null,
  guest_id text not null,
  secret_hash text not null,
  -- Which side the Micro Chess guest plays; the Lichess opponent has the other.
  color char(1) not null check (color in ('w', 'b')),
  opponent_name text,
  opponent_rating integer,
  opponent_is_ai boolean not null default false,
  opponent_title text,
  rated boolean not null default false,
  speed text,
  initial_clock_ms integer,
  increment_ms integer not null default 0,
  -- 'startpos' for a normal game, otherwise the FEN the game started from.
  initial_fen text not null default 'startpos',
  -- Space-separated UCI moves exactly as Lichess reports them. The browser
  -- replays them through chess.js; nothing here interprets chess rules.
  moves text not null default '',
  move_count integer not null default 0,
  -- Lichess status name: created/started/mate/resign/outoftime/draw/aborted/...
  status text not null default 'created',
  winner char(1) check (winner is null or winner in ('w', 'b')),
  white_clock_ms integer,
  black_clock_ms integer,
  -- 'w'/'b' when that side has a draw offer pending.
  draw_offer_by char(1) check (draw_offer_by is null or draw_offer_by in ('w', 'b')),
  finished boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_sync_at timestamptz
);

create index if not exists lichess_games_guest on public.lichess_games (guest_id, finished, updated_at desc);
create index if not exists lichess_seats_claimable on public.lichess_seats (status, lease_expires_at);

drop trigger if exists lichess_seats_set_updated_at on public.lichess_seats;
create trigger lichess_seats_set_updated_at before update on public.lichess_seats
  for each row execute procedure public.set_updated_at();

drop trigger if exists lichess_games_set_updated_at on public.lichess_games;
create trigger lichess_games_set_updated_at before update on public.lichess_games
  for each row execute procedure public.set_updated_at();

-- Reconcile the seat table with the tokens currently configured on the function.
-- p_slots: [{"seat_id": "slot-0", "fingerprint": "<sha256 prefix>"}, ...]
create or replace function public.lichess_sync_seats(p_slots jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare slot jsonb;
begin
  for slot in select * from jsonb_array_elements(coalesce(p_slots, '[]'::jsonb)) loop
    -- A different token in this slot means the existing lease refers to an
    -- account we can no longer reach: reset the seat rather than leave it wedged.
    update public.lichess_seats
    set token_fingerprint = slot->>'fingerprint', status = 'idle', guest_id = null,
        secret_hash = null, game_id = null, lease_expires_at = null, lichess_username = null
    where seat_id = slot->>'seat_id' and token_fingerprint <> slot->>'fingerprint';

    insert into public.lichess_seats (seat_id, token_fingerprint)
    values (slot->>'seat_id', slot->>'fingerprint')
    on conflict (seat_id) do nothing;
  end loop;

  delete from public.lichess_seats
  where seat_id not in (
    select value->>'seat_id' from jsonb_array_elements(coalesce(p_slots, '[]'::jsonb)) as value
  );
end;
$$;

-- Hand this guest a seat, or null when every configured token is busy.
-- Re-entrant: a guest already holding a seat gets the same one with a fresh
-- lease, so repeated polling never consumes extra capacity.
create or replace function public.lichess_claim_seat(p_guest_id text, p_secret_hash text, p_lease_seconds integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare seat public.lichess_seats%rowtype;
begin
  select * into seat from public.lichess_seats
  where guest_id = p_guest_id and secret_hash = p_secret_hash and status in ('seeking', 'playing')
  order by updated_at desc for update limit 1;

  if not found then
    select * into seat from public.lichess_seats
    where status = 'idle'
      and (lease_expires_at is null or lease_expires_at < now())
      and (cooldown_until is null or cooldown_until < now())
    order by updated_at
    for update skip locked limit 1;
    if not found then return null; end if;
  end if;

  update public.lichess_seats
  set guest_id = p_guest_id,
      secret_hash = p_secret_hash,
      status = case when status = 'playing' then 'playing' else 'seeking' end,
      lease_expires_at = now() + make_interval(secs => greatest(30, p_lease_seconds))
  where seat_id = seat.seat_id
  returning * into seat;

  return to_jsonb(seat);
end;
$$;

create or replace function public.lichess_touch_seat(p_seat_id text, p_guest_id text, p_lease_seconds integer)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.lichess_seats
  set lease_expires_at = now() + make_interval(secs => greatest(30, p_lease_seconds))
  where seat_id = p_seat_id and guest_id = p_guest_id;
end;
$$;

-- Bind a freshly paired Lichess game to the guest holding the seat. The guest's
-- secret hash is stored on the game row so only they can relay moves into it.
create or replace function public.lichess_attach_game(
  p_seat_id text, p_guest_id text, p_secret_hash text, p_lease_seconds integer, p_game jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare game_row public.lichess_games%rowtype;
begin
  -- A game already on file belongs to whoever claimed it first. Re-attaching is
  -- fine for that guest (idempotent retry) but must never hand a stranger the
  -- keys to someone else's game.
  select * into game_row from public.lichess_games where game_id = p_game->>'game_id' for update;
  if found then
    if game_row.guest_id <> p_guest_id or game_row.secret_hash <> p_secret_hash then
      raise exception 'That Lichess game is already attached to another player';
    end if;
    update public.lichess_games set seat_id = p_seat_id, last_sync_at = now()
    where game_id = game_row.game_id returning * into game_row;
    update public.lichess_seats
    set status = 'playing', game_id = game_row.game_id,
        lease_expires_at = now() + make_interval(secs => greatest(30, p_lease_seconds))
    where seat_id = p_seat_id;
    return to_jsonb(game_row);
  end if;

  insert into public.lichess_games (
    game_id, seat_id, guest_id, secret_hash, color, opponent_name, opponent_rating,
    opponent_is_ai, opponent_title, rated, speed, initial_clock_ms, increment_ms,
    initial_fen, moves, move_count, status, winner, white_clock_ms, black_clock_ms,
    finished, last_sync_at
  ) values (
    p_game->>'game_id', p_seat_id, p_guest_id, p_secret_hash, p_game->>'color',
    p_game->>'opponent_name', nullif(p_game->>'opponent_rating', '')::integer,
    coalesce((p_game->>'opponent_is_ai')::boolean, false), p_game->>'opponent_title',
    coalesce((p_game->>'rated')::boolean, false), p_game->>'speed',
    nullif(p_game->>'initial_clock_ms', '')::integer,
    coalesce(nullif(p_game->>'increment_ms', '')::integer, 0),
    coalesce(p_game->>'initial_fen', 'startpos'), coalesce(p_game->>'moves', ''),
    coalesce(nullif(p_game->>'move_count', '')::integer, 0),
    coalesce(p_game->>'status', 'started'), nullif(p_game->>'winner', ''),
    nullif(p_game->>'white_clock_ms', '')::integer, nullif(p_game->>'black_clock_ms', '')::integer,
    coalesce((p_game->>'finished')::boolean, false), now()
  )
  -- Guards the gap between the lookup above and this insert: on a concurrent
  -- attach, only the guest who owns the row may take it.
  on conflict (game_id) do update set last_sync_at = now()
    where lichess_games.guest_id = p_guest_id
  returning * into game_row;
  if not found then
    raise exception 'That Lichess game is already attached to another player';
  end if;

  update public.lichess_seats
  set status = 'playing', game_id = game_row.game_id,
      lease_expires_at = now() + make_interval(secs => greatest(30, p_lease_seconds))
  where seat_id = p_seat_id;

  return to_jsonb(game_row);
end;
$$;

create or replace function public.lichess_release_seat(p_seat_id text, p_guest_id text)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.lichess_seats
  set status = 'idle', guest_id = null, secret_hash = null, game_id = null, lease_expires_at = null
  where seat_id = p_seat_id and (p_guest_id is null or guest_id = p_guest_id);
end;
$$;

create or replace function public.lichess_cooldown_seat(p_seat_id text, p_seconds integer)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.lichess_seats
  set cooldown_until = now() + make_interval(secs => greatest(1, p_seconds))
  where seat_id = p_seat_id;
end;
$$;

-- Seats whose holder stopped polling. They are moved to 'reaping' (still not
-- claimable) and returned so the caller can resign the abandoned game on
-- Lichess — leaving it live would strand the opponent and block the account —
-- and only then release the seat.
create or replace function public.lichess_expire_seats()
returns jsonb language plpgsql security definer set search_path = public as $$
declare seat public.lichess_seats%rowtype; expired jsonb := '[]'::jsonb;
begin
  for seat in
    select * from public.lichess_seats
    where status in ('seeking', 'playing', 'reaping')
      and lease_expires_at is not null and lease_expires_at < now()
    for update skip locked
  loop
    update public.lichess_seats
    set status = 'reaping', lease_expires_at = now() + interval '2 minutes'
    where seat_id = seat.seat_id;
    expired := expired || jsonb_build_object(
      'seat_id', seat.seat_id, 'game_id', seat.game_id, 'guest_id', seat.guest_id
    );
  end loop;
  return expired;
end;
$$;

alter table public.lichess_seats enable row level security;
alter table public.lichess_games enable row level security;
revoke all on public.lichess_seats, public.lichess_games from anon, authenticated;
revoke all on function public.lichess_sync_seats(jsonb) from public;
revoke all on function public.lichess_claim_seat(text, text, integer) from public;
revoke all on function public.lichess_touch_seat(text, text, integer) from public;
revoke all on function public.lichess_attach_game(text, text, text, integer, jsonb) from public;
revoke all on function public.lichess_release_seat(text, text) from public;
revoke all on function public.lichess_cooldown_seat(text, integer) from public;
revoke all on function public.lichess_expire_seats() from public;
grant execute on function public.lichess_sync_seats(jsonb) to service_role;
grant execute on function public.lichess_claim_seat(text, text, integer) to service_role;
grant execute on function public.lichess_touch_seat(text, text, integer) to service_role;
grant execute on function public.lichess_attach_game(text, text, text, integer, jsonb) to service_role;
grant execute on function public.lichess_release_seat(text, text) to service_role;
grant execute on function public.lichess_cooldown_seat(text, integer) to service_role;
grant execute on function public.lichess_expire_seats() to service_role;
