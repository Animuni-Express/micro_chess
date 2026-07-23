-- The "COPY LINK" button shares a URL keyed by game id (?game=<uuid>) while the
-- room is still 'waiting' for a second player. Opening that link previously
-- only fetched the game (get_game), which rejects anyone who isn't already a
-- recognized player with "Game access denied" — there was no way to actually
-- join through the shared link, only through the separate room-code field.
-- This mirrors join_multiplayer_room but keyed by id instead of room_code, so
-- a fresh guest opening the link can be seated as the second player.
create or replace function public.join_multiplayer_game_by_id(p_game_id uuid, p_guest_id text, p_secret_hash text)
returns uuid language plpgsql security definer set search_path = public as $$
declare game_row public.games%rowtype;
begin
  select * into game_row from public.games where id = p_game_id for update;
  if not found then raise exception 'Game not found'; end if;
  if game_row.mode <> 'room' then raise exception 'This game cannot be joined by link'; end if;
  if game_row.status = 'waiting' and game_row.expires_at < now() then
    update public.games set status = 'expired' where id = game_row.id;
    raise exception 'This room has expired';
  end if;
  if game_row.white_player_id = p_guest_id then
    if game_row.white_secret_hash <> p_secret_hash then raise exception 'Game access denied'; end if;
    return game_row.id;
  end if;
  if game_row.black_player_id = p_guest_id then
    if game_row.black_secret_hash <> p_secret_hash then raise exception 'Game access denied'; end if;
    return game_row.id;
  end if;
  if game_row.status <> 'waiting' then raise exception 'Game access denied'; end if;
  if game_row.white_player_id is null then
    update public.games set white_player_id = p_guest_id, white_secret_hash = p_secret_hash, status = 'active', clock_started_at = now(), last_activity_at = now() where id = game_row.id;
  else
    update public.games set black_player_id = p_guest_id, black_secret_hash = p_secret_hash, status = 'active', clock_started_at = now(), last_activity_at = now() where id = game_row.id;
  end if;
  return game_row.id;
end;
$$;

revoke all on function public.join_multiplayer_game_by_id(uuid, text, text) from public;
grant execute on function public.join_multiplayer_game_by_id(uuid, text, text) to service_role;
