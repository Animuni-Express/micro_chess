CREATE TABLE mc_rooms (
  room_id text PRIMARY KEY,
  game_id uuid NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'waiting',
  generation integer NOT NULL DEFAULT 1,
  reconnect_deadline timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours'
);
CREATE TABLE mc_seats (
  player_id uuid PRIMARY KEY,
  room_id text NOT NULL REFERENCES mc_rooms ON DELETE CASCADE,
  color text NOT NULL CHECK (color IN ('w','b')),
  token_hash text NOT NULL,
  instance_id uuid NOT NULL,
  checkpoint jsonb,
  generation integer NOT NULL DEFAULT 1,
  ready boolean NOT NULL DEFAULT false,
  finish_result text,
  UNIQUE(room_id,color)
);
CREATE TABLE mc_signals (
  id bigserial PRIMARY KEY,
  room_id text NOT NULL REFERENCES mc_rooms ON DELETE CASCADE,
  generation integer NOT NULL,
  sender uuid NOT NULL,
  target uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('offer','answer','candidate')),
  payload jsonb NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '2 minutes'
);
CREATE INDEX mc_signal_cursor ON mc_signals(room_id,generation,target,id);
CREATE TABLE mc_queue (
  player_id uuid PRIMARY KEY,
  token_hash text NOT NULL,
  instance_id uuid NOT NULL,
  room_id text REFERENCES mc_rooms ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '2 minutes'
);
CREATE TABLE mc_limits (key text PRIMARY KEY, count integer NOT NULL, expires_at timestamptz NOT NULL);

-- One SQL call is one transaction, including locks, claims and cascading deletion.
CREATE FUNCTION mc_control(action text, p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  r mc_rooms; s mc_seats; opponent mc_seats; q mc_queue;
  player uuid; inst uuid; token text; response jsonb; count_now integer;
BEGIN
  IF action = 'cleanup' THEN
    DELETE FROM mc_queue WHERE expires_at < now();
    DELETE FROM mc_signals WHERE expires_at < now();
    DELETE FROM mc_rooms WHERE expires_at < now()
      OR (status = 'waiting' AND created_at < now() - interval '10 minutes')
      OR (status = 'connecting' AND created_at < now() - interval '5 minutes')
      OR (reconnect_deadline < now() - interval '2 minutes');
    DELETE FROM mc_limits WHERE expires_at < now();
    RETURN '{"status":"cleaned"}';
  END IF;
  INSERT INTO mc_limits VALUES (p->>'rateKey', 1, now() + interval '1 minute')
    ON CONFLICT (key) DO UPDATE SET count = CASE WHEN mc_limits.expires_at < now() THEN 1 ELSE mc_limits.count+1 END,
    expires_at = CASE WHEN mc_limits.expires_at < now() THEN now()+interval '1 minute' ELSE mc_limits.expires_at END
    RETURNING count INTO count_now;
  IF count_now > 240 THEN RETURN '{"error":"Too many requests. Try again shortly.","code":429}'; END IF;
  player := (p->>'playerId')::uuid; inst := (p->>'instanceId')::uuid; token := p->>'tokenHash';

  IF action IN ('room','join','matchmaking') THEN
    -- Serialize only the short queue/seat-creation transaction; no long-lived locks.
    PERFORM pg_advisory_xact_lock(72644201);
    SELECT * INTO s FROM mc_seats WHERE player_id = player;
    IF FOUND THEN
      IF s.token_hash <> token OR s.instance_id <> inst THEN RETURN '{"error":"Session access denied","code":403}'; END IF;
      SELECT * INTO r FROM mc_rooms WHERE room_id = s.room_id;
    ELSIF action = 'room' THEN
      INSERT INTO mc_rooms(room_id,game_id) VALUES(p->>'newRoomId',(p->>'newGameId')::uuid) RETURNING * INTO r;
      INSERT INTO mc_seats(player_id,room_id,color,token_hash,instance_id) VALUES(player,r.room_id,'w',token,inst) RETURNING * INTO s;
    ELSIF action = 'join' THEN
      SELECT * INTO r FROM mc_rooms WHERE room_id = p->>'roomId' FOR UPDATE;
      IF NOT FOUND OR r.expires_at < now() OR r.created_at < now()-interval '10 minutes' THEN RETURN '{"error":"Room not found or expired","code":404}'; END IF;
      IF r.status <> 'waiting' THEN RETURN '{"error":"Room is full","code":409}'; END IF;
      INSERT INTO mc_seats(player_id,room_id,color,token_hash,instance_id) VALUES(player,r.room_id,'b',token,inst) RETURNING * INTO s;
      UPDATE mc_rooms SET status='connecting' WHERE room_id=r.room_id RETURNING * INTO r;
    ELSE
      SELECT * INTO q FROM mc_queue WHERE player_id=player FOR UPDATE;
      IF FOUND THEN
        IF q.token_hash <> token OR q.instance_id <> inst THEN RETURN '{"error":"Session access denied","code":403}'; END IF;
        IF q.expires_at < now() THEN RETURN '{"status":"expired"}'; END IF;
        RETURN '{"status":"waiting"}';
      END IF;
      SELECT * INTO q FROM mc_queue WHERE room_id IS NULL AND expires_at > now() AND player_id <> player ORDER BY created_at LIMIT 1 FOR UPDATE;
      IF NOT FOUND THEN
        INSERT INTO mc_queue(player_id,token_hash,instance_id) VALUES(player,token,inst);
        RETURN '{"status":"waiting"}';
      END IF;
      INSERT INTO mc_rooms(room_id,game_id,status) VALUES(p->>'newRoomId',(p->>'newGameId')::uuid,'connecting') RETURNING * INTO r;
      INSERT INTO mc_seats(player_id,room_id,color,token_hash,instance_id) VALUES(q.player_id,r.room_id,'w',q.token_hash,q.instance_id);
      INSERT INTO mc_seats(player_id,room_id,color,token_hash,instance_id) VALUES(player,r.room_id,'b',token,inst) RETURNING * INTO s;
      UPDATE mc_queue SET room_id=r.room_id WHERE player_id=q.player_id;
    END IF;
  ELSIF action IN ('matchmaking/status','cancel') THEN
    PERFORM pg_advisory_xact_lock(72644201);
    SELECT * INTO q FROM mc_queue WHERE player_id=player FOR UPDATE;
    IF NOT FOUND THEN RETURN '{"status":"expired"}'; END IF;
    IF q.token_hash <> token OR q.instance_id <> inst THEN RETURN '{"error":"Session access denied","code":403}'; END IF;
    IF q.room_id IS NULL THEN
      IF action = 'cancel' THEN DELETE FROM mc_queue WHERE player_id=player; RETURN '{"status":"cancelled"}'; END IF;
      IF q.expires_at < now() THEN DELETE FROM mc_queue WHERE player_id=player; RETURN '{"status":"expired"}'; END IF;
      RETURN '{"status":"waiting"}';
    END IF;
    SELECT * INTO s FROM mc_seats WHERE player_id=player;
    SELECT * INTO r FROM mc_rooms WHERE room_id=s.room_id FOR UPDATE;
  ELSE
    SELECT * INTO r FROM mc_rooms WHERE room_id=p->>'roomId' FOR UPDATE;
    IF NOT FOUND THEN
      IF action='finish' THEN RETURN '{"status":"finished"}'; END IF;
      RETURN '{"error":"Room expired","code":410}';
    END IF;
    IF r.expires_at < now() THEN RETURN '{"error":"Room expired","code":410}'; END IF;
    SELECT * INTO s FROM mc_seats WHERE room_id=r.room_id AND player_id=player;
    IF NOT FOUND OR s.token_hash <> token OR r.game_id::text <> p->>'gameId' THEN RETURN '{"error":"Session access denied","code":403}'; END IF;
    IF s.instance_id <> inst AND action <> 'reconnect' THEN RETURN '{"error":"This game is open in another browser instance","code":409}'; END IF;
    IF action NOT IN ('reconnect','reconnect/status','status','finish') AND (p->>'generation')::integer <> r.generation THEN RETURN '{"error":"Stale connection","code":409}'; END IF;
    SELECT * INTO opponent FROM mc_seats WHERE room_id=r.room_id AND player_id<>player;
    IF action='signal' THEN
      IF r.status NOT IN ('connecting','reconnecting') OR opponent.player_id IS NULL OR opponent.player_id::text <> p->>'target' THEN RETURN '{"error":"Invalid connection target","code":409}'; END IF;
      IF (SELECT count(*) FROM mc_signals WHERE room_id=r.room_id AND generation=r.generation) >= 512 THEN RETURN '{"error":"Too many connection messages","code":429}'; END IF;
      INSERT INTO mc_signals(room_id,generation,sender,target,kind,payload) VALUES(r.room_id,r.generation,player,opponent.player_id,p->>'kind',p->'payload');
      RETURN '{"status":"ok"}';
    ELSIF action='signals' THEN
      SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]') INTO response FROM
        (SELECT id,kind,payload FROM mc_signals WHERE room_id=r.room_id AND generation=r.generation AND target=player AND id > (p->>'after')::bigint AND expires_at>now() ORDER BY id LIMIT 128) t;
      RETURN jsonb_build_object('signals',response);
    ELSIF action='ready' THEN
      UPDATE mc_seats SET ready=true WHERE player_id=player;
      IF NOT EXISTS(SELECT 1 FROM mc_seats WHERE room_id=r.room_id AND NOT ready) THEN
        UPDATE mc_rooms SET status='active',reconnect_deadline=NULL WHERE room_id=r.room_id;
        DELETE FROM mc_signals WHERE room_id=r.room_id;
      END IF;
      RETURN '{"status":"ok"}';
    ELSIF action='reconnect' THEN
      IF r.status='finishing' THEN RETURN '{"error":"Game is finishing","code":409}'; END IF;
      IF (p->>'generation')::integer <> r.generation AND NOT
        (r.status='reconnecting' AND (p->>'generation')::integer=r.generation-1 AND (s.generation<r.generation OR s.instance_id=inst))
        THEN RETURN '{"error":"Stale connection","code":409}'; END IF;
      IF r.status='reconnecting' AND s.generation=r.generation AND s.instance_id<>inst THEN
        RETURN '{"error":"This seat has already reconnected","code":409}';
      END IF;
      IF r.status <> 'reconnecting' THEN
        UPDATE mc_rooms SET status='reconnecting',generation=generation+1,reconnect_deadline=now()+interval '90 seconds' WHERE room_id=r.room_id RETURNING * INTO r;
        UPDATE mc_seats SET ready=false WHERE room_id=r.room_id;
        DELETE FROM mc_signals WHERE room_id=r.room_id;
      END IF;
      IF r.reconnect_deadline < now() THEN RETURN '{"status":"expired"}'; END IF;
      UPDATE mc_seats SET instance_id=inst,checkpoint=p->'checkpoint',generation=r.generation WHERE player_id=player RETURNING * INTO s;
    ELSIF action='finish' THEN
      IF p->>'result' NOT IN ('draw','white_won','black_won') THEN RETURN '{"error":"Invalid result","code":400}'; END IF;
      IF r.status='reconnecting' AND r.reconnect_deadline < now() AND s.generation=r.generation AND opponent.generation<>r.generation THEN
        DELETE FROM mc_rooms WHERE room_id=r.room_id;
        RETURN '{"status":"finished"}';
      END IF;
      IF s.instance_id<>inst OR (p->>'generation')::integer<>r.generation THEN RETURN '{"error":"Stale connection","code":409}'; END IF;
      UPDATE mc_seats SET finish_result=p->>'result' WHERE player_id=player;
      IF opponent.finish_result=p->>'result' THEN
        DELETE FROM mc_rooms WHERE room_id=r.room_id;
        RETURN '{"status":"finished"}';
      END IF;
      UPDATE mc_rooms SET status='finishing',reconnect_deadline=coalesce(reconnect_deadline,now()+interval '90 seconds') WHERE room_id=r.room_id;
      RETURN '{"status":"finishing"}';
    ELSIF action NOT IN ('status','reconnect/status') THEN
      RETURN '{"error":"Unknown action","code":404}';
    END IF;
  END IF;
  SELECT * INTO opponent FROM mc_seats WHERE room_id=r.room_id AND player_id<>player;
  RETURN jsonb_build_object('roomId',r.room_id,'gameId',r.game_id,'playerId',s.player_id,'color',s.color,
    'generation',r.generation,'status',CASE WHEN r.reconnect_deadline<now() THEN 'expired' ELSE r.status END,
    'opponentId',opponent.player_id,'deadline',r.reconnect_deadline,
    'opponentReturned',opponent.generation=r.generation,'checkpoint',opponent.checkpoint);
END;
$$;
