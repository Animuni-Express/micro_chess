import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Board } from './Board';
import { PromotionDialog } from './PromotionDialog';
import { createOnlineGame, movePayload } from '../core/onlineGame';
import { multiplayer, subscribeToGame } from '../multiplayer/client';

const TIME_CONTROLS = [
  { value: 300, label: '5 minutes' },
  { value: 600, label: '10 minutes' },
];

function formatClock(milliseconds) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function pathGameId() {
  return new URLSearchParams(window.location.search).get('game');
}

function setGameUrl(gameId) {
  const url = new URL(window.location.href);
  url.searchParams.set('game', gameId);
  window.history.replaceState({}, '', url);
}

function statusText(game, color) {
  if (!game) return 'Loading game…';
  if (game.status === 'waiting') return 'Waiting for an opponent…';
  if (game.status === 'finished') {
    if (game.result === 'draw') return 'Game drawn.';
    if (game.result === 'white_won') return 'White wins.';
    if (game.result === 'black_won') return 'Black wins.';
    return 'Game finished.';
  }
  return game.turn === color ? 'Your move' : "Opponent's move";
}

function Clock({ label, value, active }) {
  return (
    <div className={'clock' + (active ? ' active' : '')}>
      <span>{label}</span>
      <strong>{formatClock(value)}</strong>
    </div>
  );
}

export function OnlineGameApp() {
  const [gameId, setGameId] = useState(pathGameId);
  const [game, setGame] = useState(null);
  const [playerColor, setPlayerColor] = useState(null);
  const [selectedSquare, setSelectedSquare] = useState(null);
  const [pendingPromotion, setPendingPromotion] = useState(null);
  const [pendingMove, setPendingMove] = useState(false);
  const [message, setMessage] = useState('');
  const [connection, setConnection] = useState('connecting');
  const [clockNow, setClockNow] = useState(Date.now());
  const [roomCode, setRoomCode] = useState('');
  const [timeControl, setTimeControl] = useState(300);
  const [queueing, setQueueing] = useState(false);
  const unsubscribe = useRef(null);

  const chess = useMemo(() => createOnlineGame(game?.current_fen), [game?.current_fen]);
  const validMoves = selectedSquare ? chess.moves({ square: selectedSquare, verbose: true }) : [];
  const canMove = game?.status === 'active' && game.turn === playerColor && !pendingMove;

  const refreshGame = useCallback(async (id = gameId) => {
    if (!id) return;
    try {
      const response = await multiplayer('get_game', { gameId: id });
      setGame(response.game);
      setPlayerColor(response.playerColor);
      setConnection('connected');
      setSelectedSquare(null);
      setPendingPromotion(null);
    } catch (error) {
      setConnection('reconnecting');
      setMessage(error.message);
    }
  }, [gameId]);

  const openGame = useCallback((id, response) => {
    setGameId(id);
    setGame(response?.game || null);
    setPlayerColor(response?.playerColor || null);
    setGameUrl(id);
    setMessage('');
  }, []);

  useEffect(() => {
    if (!gameId) return undefined;
    let cancelled = false;
    refreshGame(gameId);
    const timer = window.setInterval(() => refreshGame(gameId), 5000);
    subscribeToGame(gameId, (payload) => {
      if (cancelled || !payload?.game) return;
      // Broadcasts are shared to both players, so the payload never carries a
      // player-specific color — only `refreshGame`/`openGame` (each scoped to
      // the requesting player via the Edge Function) may set playerColor.
      setGame(payload.game);
      setConnection('connected');
      setSelectedSquare(null);
      setPendingPromotion(null);
    })
      .then((remove) => {
        if (cancelled) remove();
        else unsubscribe.current = remove;
      })
      .catch(() => setConnection('polling'));
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      if (unsubscribe.current) unsubscribe.current();
      unsubscribe.current = null;
    };
  }, [gameId, refreshGame]);

  useEffect(() => {
    const timer = window.setInterval(() => setClockNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    window.render_game_to_text = () => JSON.stringify({
      screen: gameId ? 'game' : queueing ? 'matchmaking' : 'lobby',
      gameId: game?.id || null,
      status: game?.status || null,
      playerColor,
      turn: game?.turn || null,
      timeControl: game?.time_control || timeControl,
      connection,
      message: message || null,
    });
    window.advanceTime = () => setClockNow(Date.now());
    return () => {
      delete window.render_game_to_text;
      delete window.advanceTime;
    };
  }, [gameId, queueing, game, playerColor, timeControl, connection, message]);

  useEffect(() => {
    if (!queueing) return undefined;
    const timer = window.setInterval(async () => {
      try {
        const response = await multiplayer('matchmaking_status');
        if (response.gameId) {
          setQueueing(false);
          openGame(response.gameId, response);
        }
      } catch (error) {
        setMessage(error.message);
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [queueing, openGame]);

  const displayedClock = (color) => {
    if (!game) return 0;
    const base = color === 'w' ? game.white_clock_ms : game.black_clock_ms;
    if (game.status !== 'active' || game.turn !== color || !game.clock_started_at) return base;
    return Math.max(0, base - (clockNow - new Date(game.clock_started_at).getTime()));
  };

  const createRoom = useCallback(async () => {
    setMessage('Creating room…');
    try {
      const response = await multiplayer('create_room', { timeControl });
      openGame(response.game.id, response);
    } catch (error) {
      setMessage(error.message);
    }
  }, [timeControl, openGame]);

  const joinRoom = useCallback(async () => {
    if (!roomCode.trim()) return setMessage('Enter a room code first.');
    setMessage('Joining room…');
    try {
      const response = await multiplayer('join_room', { roomCode: roomCode.trim().toUpperCase() });
      openGame(response.game.id, response);
    } catch (error) {
      setMessage(error.message);
    }
  }, [roomCode, openGame]);

  const joinMatchmaking = useCallback(async () => {
    setMessage('Finding an opponent…');
    try {
      const response = await multiplayer('join_matchmaking', { timeControl });
      if (response.gameId) openGame(response.gameId, response);
      else setQueueing(true);
    } catch (error) {
      setMessage(error.message);
    }
  }, [timeControl, openGame]);

  const leaveMatchmaking = useCallback(async () => {
    try {
      await multiplayer('leave_matchmaking');
    } finally {
      setQueueing(false);
      setMessage('Matchmaking cancelled.');
    }
  }, []);

  const submitMove = useCallback(async (from, to, promotion) => {
    if (!game || !canMove) return;
    const localMove = movePayload(chess, from, to, promotion);
    if (!localMove) {
      setSelectedSquare(null);
      return;
    }
    setPendingMove(true);
    setSelectedSquare(null);
    setPendingPromotion(null);
    try {
      const response = await multiplayer('submit_move', {
        gameId: game.id,
        from,
        to,
        promotion: promotion || null,
        expectedVersion: game.position_version,
      });
      setGame(response.game);
      setPlayerColor(response.playerColor);
      setConnection('connected');
    } catch (error) {
      setMessage(error.message);
      await refreshGame();
    } finally {
      setPendingMove(false);
    }
  }, [game, canMove, chess, refreshGame]);

  const onSquareClick = useCallback((square) => {
    if (!canMove) return;
    const clicked = chess.get(square);
    if (!selectedSquare) {
      if (clicked?.color === playerColor) setSelectedSquare(square);
      return;
    }
    if (square === selectedSquare) {
      setSelectedSquare(null);
    } else if (clicked?.color === playerColor) {
      setSelectedSquare(square);
    } else {
      const promotion = chess.get(selectedSquare)?.type === 'p' && (square[1] === '1' || square[1] === '8');
      if (promotion) setPendingPromotion({ from: selectedSquare, to: square, color: playerColor });
      else submitMove(selectedSquare, square);
    }
  }, [canMove, chess, selectedSquare, playerColor, submitMove]);

  const gameAction = useCallback(async (action) => {
    if (!game) return;
    try {
      const response = await multiplayer(action, { gameId: game.id });
      if (response.game) setGame(response.game);
      setMessage('');
    } catch (error) {
      setMessage(error.message);
    }
  }, [game]);

  if (!gameId) {
    return (
      <div className="setup-view online-lobby">
        <h2>Play Online</h2>
        <p className="online-help">Private rooms or a quick match with another player.</p>
        <div className="setup-option">
          <label htmlFor="time-control">TIME CONTROL</label>
          <select id="time-control" className="level-select" value={timeControl} onChange={(event) => setTimeControl(Number(event.currentTarget.value))}>
            {TIME_CONTROLS.map((control) => <option value={control.value} key={control.value}>{control.label}</option>)}
          </select>
        </div>
        <button className="start-btn" onClick={createRoom}>CREATE PRIVATE ROOM</button>
        <div className="room-join">
          <input aria-label="Room code" maxLength="6" value={roomCode} onInput={(event) => setRoomCode(event.currentTarget.value.toUpperCase())} placeholder="ROOM CODE" />
          <button className="btn btn-secondary" onClick={joinRoom}>JOIN ROOM</button>
        </div>
        <div className="online-divider"><span>OR</span></div>
        {queueing ? (
          <div className="queue-status"><p>Finding a {timeControl / 60}-minute opponent…</p><button className="btn btn-secondary" onClick={leaveMatchmaking}>CANCEL</button></div>
        ) : (
          <button className="btn online-match-button" onClick={joinMatchmaking}>FIND A MATCH</button>
        )}
        {message && <p className="online-message" role="status">{message}</p>}
      </div>
    );
  }

  const shareUrl = new URL(window.location.href);
  shareUrl.searchParams.set('game', gameId);
  const isDrawOffer = game?.draw_offer_by && game.draw_offer_by !== playerColor;

  return (
    <div className="container online-game">
      <div className="header">
        <h1>♟ Online Chess ♟</h1>
        <div className="online-meta"><span className={`connection ${connection}`}>{connection}</span><span>{game?.mode === 'room' ? `Room ${game.room_code}` : `${(game?.time_control || 300) / 60} min match`}</span></div>
      </div>
      {game?.mode === 'room' && game.status === 'waiting' && (
        <div className="share-room"><strong>Share room code: {game.room_code}</strong><button className="btn btn-secondary" onClick={() => navigator.clipboard?.writeText(shareUrl.href)}>COPY LINK</button></div>
      )}
      <Clock label={playerColor === 'b' ? 'You (Black)' : 'Opponent (Black)'} value={displayedClock('b')} active={game?.turn === 'b'} />
      <div className="board-container">
        <Board position={chess.board()} selectedSquare={selectedSquare} validMoves={validMoves} turn={chess.turn()} inCheck={chess.in_check()} flip={playerColor === 'b'} rotatePieces={false} onSquareClick={onSquareClick} />
        <PromotionDialog visible={!!pendingPromotion} color={pendingPromotion?.color || 'w'} onChoose={(piece) => submitMove(pendingPromotion.from, pendingPromotion.to, piece)} />
      </div>
      <Clock label={playerColor === 'w' ? 'You (White)' : 'Opponent (White)'} value={displayedClock('w')} active={game?.turn === 'w'} />
      <div id="status" className={pendingMove ? 'thinking' : ''}>{pendingMove ? 'Sending move…' : statusText(game, playerColor)}</div>
      {isDrawOffer && <div className="draw-offer">Opponent offered a draw.<button className="btn" onClick={() => gameAction('accept_draw')}>ACCEPT DRAW</button><button className="btn btn-secondary" onClick={() => gameAction('decline_draw')}>DECLINE</button></div>}
      {game?.status === 'active' && <div className="controls"><button className="btn btn-secondary" onClick={() => gameAction('offer_draw')}>OFFER DRAW</button><button className="btn" onClick={() => gameAction('resign')}>RESIGN</button></div>}
      {message && <p className="online-message" role="status">{message}</p>}
    </div>
  );
}
