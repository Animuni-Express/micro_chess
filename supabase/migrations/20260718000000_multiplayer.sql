create extension if not exists pgcrypto;

create table if not exists public.games (
  id uuid primary key default gen_random_uuid(),
  mode text not null check (mode in ('room', 'matchmaking')),
  room_code text unique check (room_code is null or room_code ~ '^[A-Z0-9]{6}$'),
  time_control integer not null check (time_control in (300, 600)),
  status text not null default 'waiting' check (status in ('waiting', 'active', 'finished', 'expired')),
  white_player_id text,
  black_player_id text,
  white_secret_hash text,
  black_secret_hash text,
  current_fen text not null default 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  turn char(1) not null default 'w' check (turn in ('w', 'b')),
  position_version integer not null default 0 check (position_version >= 0),
  white_clock_ms integer not null check (white_clock_ms >= 0),
  black_clock_ms integer not null check (black_clock_ms >= 0),
  clock_started_at timestamptz,
  draw_offer_by char(1) check (draw_offer_by is null or draw_offer_by in ('w', 'b')),
  result text check (result is null or result in ('white_won', 'black_won', 'draw', 'abandoned')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  expires_at timestamptz
);

create table if not exists public.moves (
  id bigint generated always as identity primary key,
  game_id uuid not null references public.games(id) on delete cascade,
  move_number integer not null,
  player_color char(1) not null check (player_color in ('w', 'b')),
  from_square char(2) not null,
  to_square char(2) not null,
  promotion char(1),
  san text not null,
  fen_after text not null,
  created_at timestamptz not null default now(),
  unique (game_id, move_number)
);

create table if not exists public.matchmaking_queue (
  guest_id text primary key,
  secret_hash text not null,
  time_control integer not null check (time_control in (300, 600)),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists matchmaking_queue_lookup on public.matchmaking_queue (time_control, created_at);

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

drop trigger if exists games_set_updated_at on public.games;
create trigger games_set_updated_at before update on public.games for each row execute procedure public.set_updated_at();

create or replace function public.join_multiplayer_room(p_room_code text, p_guest_id text, p_secret_hash text)
returns uuid language plpgsql security definer set search_path = public as $$
declare game_row public.games%rowtype;
begin
  select * into game_row from public.games where room_code = upper(p_room_code) for update;
  if not found then raise exception 'Room not found'; end if;
  if game_row.status = 'waiting' and game_row.expires_at < now() then
    update public.games set status = 'expired' where id = game_row.id;
    raise exception 'This room has expired';
  end if;
  if game_row.white_player_id = p_guest_id then
    if game_row.white_secret_hash <> p_secret_hash then raise exception 'Room access denied'; end if;
    return game_row.id;
  end if;
  if game_row.black_player_id = p_guest_id then
    if game_row.black_secret_hash <> p_secret_hash then raise exception 'Room access denied'; end if;
    return game_row.id;
  end if;
  if game_row.status <> 'waiting' then raise exception 'Room is full'; end if;
  if game_row.white_player_id is null then
    update public.games set white_player_id = p_guest_id, white_secret_hash = p_secret_hash, status = 'active', clock_started_at = now(), last_activity_at = now() where id = game_row.id;
  else
    update public.games set black_player_id = p_guest_id, black_secret_hash = p_secret_hash, status = 'active', clock_started_at = now(), last_activity_at = now() where id = game_row.id;
  end if;
  return game_row.id;
end;
$$;

create or replace function public.queue_multiplayer_player(p_guest_id text, p_secret_hash text, p_time_control integer)
returns uuid language plpgsql security definer set search_path = public as $$
declare opponent public.matchmaking_queue%rowtype; new_game uuid; first_is_white boolean;
begin
  delete from public.matchmaking_queue where expires_at < now();
  delete from public.matchmaking_queue where guest_id = p_guest_id;
  select * into opponent from public.matchmaking_queue where time_control = p_time_control and expires_at > now() and guest_id <> p_guest_id order by created_at for update skip locked limit 1;
  if not found then
    insert into public.matchmaking_queue (guest_id, secret_hash, time_control, expires_at) values (p_guest_id, p_secret_hash, p_time_control, now() + interval '5 minutes');
    return null;
  end if;
  first_is_white := random() < 0.5;
  insert into public.games (mode, time_control, status, white_player_id, black_player_id, white_secret_hash, black_secret_hash, white_clock_ms, black_clock_ms, clock_started_at, expires_at)
  values ('matchmaking', p_time_control, 'active', case when first_is_white then opponent.guest_id else p_guest_id end, case when first_is_white then p_guest_id else opponent.guest_id end, case when first_is_white then opponent.secret_hash else p_secret_hash end, case when first_is_white then p_secret_hash else opponent.secret_hash end, p_time_control * 1000, p_time_control * 1000, now(), now() + interval '24 hours') returning id into new_game;
  delete from public.matchmaking_queue where guest_id = opponent.guest_id;
  return new_game;
end;
$$;

alter table public.games enable row level security;
alter table public.moves enable row level security;
alter table public.matchmaking_queue enable row level security;
revoke all on public.games, public.moves, public.matchmaking_queue from anon, authenticated;
revoke all on function public.join_multiplayer_room(text, text, text) from public;
revoke all on function public.queue_multiplayer_player(text, text, integer) from public;
grant execute on function public.join_multiplayer_room(text, text, text) to service_role;
grant execute on function public.queue_multiplayer_player(text, text, integer) to service_role;
