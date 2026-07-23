-- matchmaking_status previously found a match by selecting the player's most
-- recently updated game in ('waiting', 'active') status — which could be a
-- stale private room or an old active game, not the game just created by
-- queue_multiplayer_player. Track the actual match on the queue row instead,
-- so a status check can only ever report a match this specific queue attempt
-- produced.

alter table public.matchmaking_queue add column if not exists matched_game_id uuid references public.games(id);

create or replace function public.queue_multiplayer_player(p_guest_id text, p_secret_hash text, p_time_control integer)
returns uuid language plpgsql security definer set search_path = public as $$
declare opponent public.matchmaking_queue%rowtype; new_game uuid; first_is_white boolean;
begin
  delete from public.matchmaking_queue where expires_at < now();
  delete from public.matchmaking_queue where guest_id = p_guest_id;
  select * into opponent from public.matchmaking_queue
    where time_control = p_time_control and expires_at > now() and guest_id <> p_guest_id and matched_game_id is null
    order by created_at for update skip locked limit 1;
  if not found then
    insert into public.matchmaking_queue (guest_id, secret_hash, time_control, expires_at) values (p_guest_id, p_secret_hash, p_time_control, now() + interval '5 minutes');
    return null;
  end if;
  first_is_white := random() < 0.5;
  insert into public.games (mode, time_control, status, white_player_id, black_player_id, white_secret_hash, black_secret_hash, white_clock_ms, black_clock_ms, clock_started_at, expires_at)
  values ('matchmaking', p_time_control, 'active', case when first_is_white then opponent.guest_id else p_guest_id end, case when first_is_white then p_guest_id else opponent.guest_id end, case when first_is_white then opponent.secret_hash else p_secret_hash end, case when first_is_white then p_secret_hash else opponent.secret_hash end, p_time_control * 1000, p_time_control * 1000, now(), now() + interval '24 hours') returning id into new_game;
  -- Leave the opponent's row in place (instead of deleting it) so their next
  -- matchmaking_status poll can discover the match; extend its expiry so it
  -- isn't reaped before they poll.
  update public.matchmaking_queue set matched_game_id = new_game, expires_at = now() + interval '2 minutes' where guest_id = opponent.guest_id;
  return new_game;
end;
$$;
