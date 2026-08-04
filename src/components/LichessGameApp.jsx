import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Board } from './Board';
import { PromotionDialog } from './PromotionDialog';
import {
  canAbortRelayGame,
  describeOpponent,
  describeRelayResult,
  formatClock,
  isOurTurn,
  positionFromRelay,
  relayClockRemaining,
} from '../core/lichessGame';
import {
  activeRelayGame,
  cancelLichessSearch,
  findLichessOpponent,
  lichessGameAction,
  readLichessGame,
  relayStatus,
  sendLichessMove,
} from '../lichess/client';

const TIME_CONTROLS = [
  { value: 300, label: '5 minutes' },
  { value: 600, label: '10 minutes' },
];

function gameIdFromUrl() {
  return new URLSearchParams(window.location.search).get('lichess') || null;
}

function setUrlGame(gameId) {
  const url = new URL(window.location.href);
  if (gameId) url.searchParams.set('lichess', gameId);
  else url.searchParams.delete('lichess');
  window.history.replaceState({}, '', url);
}

function Clock({ label, value, active }) {
  return (
    <div className={'clock' + (active ? ' active' : '')}>
      <span>{label}</span>
      <strong>{formatClock(value)}</strong>
    </div>
  );
}

export function LichessGameApp({ onExit }) {
  const [game, setGame] = useState(null);
  const [timeControl, setTimeControl] = useState(300);
  const [searching, setSearching] = useState(false);
  const [message, setMessage] = useState('');
  const [relay, setRelay] = useState(null);
  const [selectedSquare, setSelectedSquare] = useState(null);
  const [pendingPromotion, setPendingPromotion] = useState(null);
  const [pendingMove, setPendingMove] = useState(false);
  const [clockNow, setClockNow] = useState(Date.now());
  // (local clock - server clock); keeps the countdown honest on devices whose
  // clock is off, since Lichess clocks are anchored to a server timestamp.
  const skewRef = useRef(0);
  const searchingRef = useRef(false);
  const gameRef = useRef(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    gameRef.current = game;
  }, [game]);

  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  const { chess, error: replayError } = useMemo(() => positionFromRelay(game), [game?.moves, game?.initialFen]);
  const turn = chess.turn();
  const ourTurn = isOurTurn(game, turn);
  const canMove = ourTurn && !pendingMove;
  const validMoves = selectedSquare ? chess.moves({ square: selectedSquare, verbose: true }) : [];

  const noteServerTime = useCallback((response) => {
    if (response?.serverNow) {
      const serverNow = Date.parse(response.serverNow);
      if (Number.isFinite(serverNow)) skewRef.current = Date.now() - serverNow;
    }
    if (response?.warning) setMessage(response.warning);
  }, []);

  const adoptGame = useCallback((next) => {
    if (!next) return;
    setGame(next);
    setUrlGame(next.gameId);
    setSelectedSquare(null);
    setPendingPromotion(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const status = await relayStatus();
        if (!cancelled) setRelay(status);
        if (!cancelled && !status?.configured) {
          setMessage('Lichess play is not configured on this server yet.');
          return;
        }
      } catch (error) {
        if (!cancelled) setMessage(error.message);
        return;
      }
      try {
        const response = await activeRelayGame();
        if (!cancelled && response?.game && !response.game.finished) {
          noteServerTime(response);
          adoptGame(response.game);
        } else if (!cancelled && gameIdFromUrl()) {
          // The URL points at a game this guest no longer owns (finished, or a
          // different browser profile) — drop the stale parameter.
          setUrlGame(null);
        }
      } catch (error) {
        if (!cancelled) setMessage(error.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [adoptGame, noteServerTime]);

  useEffect(() => {
    const timer = window.setInterval(() => setClockNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, []);

  // Search loop. Each find_opponent call holds a real seek open in the Lichess
  // pool for ~20s server-side and then reports back, so calling it in a loop
  // keeps exactly one live seek per guest without hammering the API.
  useEffect(() => {
    if (!searching) return undefined;
    let cancelled = false;
    searchingRef.current = true;
    (async () => {
      while (!cancelled && searchingRef.current) {
        try {
          const response = await findLichessOpponent(timeControl);
          if (cancelled) return;
          if (response?.busy) {
            setMessage(response.message || 'All Lichess relay seats are busy.');
            setSearching(false);
            return;
          }
          if (response?.game) {
            noteServerTime(response);
            adoptGame(response.game);
            setMessage(response.resumed ? 'Resumed your game in progress.' : '');
            setSearching(false);
            return;
          }
          setMessage(
            response?.relayAccount
              ? `Waiting in the Lichess pool as ${response.relayAccount}…`
              : 'Waiting for a Lichess player…',
          );
        } catch (error) {
          if (cancelled) return;
          setMessage(error.message);
          setSearching(false);
          return;
        }
      }
    })();
    return () => {
      cancelled = true;
      searchingRef.current = false;
    };
  }, [searching, timeControl, adoptGame, noteServerTime]);

  // Long-poll loop for the opponent's move. get_game with wait:true parks on the
  // Lichess board stream server-side, so a move shows up here within a moment of
  // being played rather than on a fixed polling beat.
  useEffect(() => {
    const gameId = game?.gameId;
    if (!gameId || game?.finished) return undefined;
    let cancelled = false;
    (async () => {
      while (!cancelled) {
        const current = gameRef.current;
        if (!current || current.gameId !== gameId || current.finished) return;
        try {
          const response = await readLichessGame(gameId, { wait: true, sinceMoveCount: current.moveCount });
          if (cancelled) return;
          noteServerTime(response);
          if (response?.game) {
            setGame((previous) => {
              if (previous?.gameId !== gameId) return previous;
              // A poll that started before our own move can come back carrying the
              // pre-move position; never let it roll the board backwards.
              const stale = !response.game.finished && response.game.moveCount < (previous.moveCount || 0);
              return stale ? previous : response.game;
            });
            if (response.game.moveCount !== current.moveCount) {
              setSelectedSquare(null);
              setPendingPromotion(null);
            }
          }
        } catch (error) {
          if (cancelled) return;
          setMessage(error.message);
          // Back off before retrying so a persistent failure does not spin.
          await new Promise((resolve) => window.setTimeout(resolve, 4000));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [game?.gameId, game?.finished, noteServerTime]);

  useEffect(() => {
    window.render_game_to_text = () => JSON.stringify({
      screen: game ? 'lichess-game' : searching ? 'lichess-searching' : 'lichess-lobby',
      gameId: game?.gameId || null,
      color: game?.color || null,
      opponent: game?.opponent?.name || null,
      moveCount: game?.moveCount ?? null,
      status: game?.status || null,
      finished: !!game?.finished,
      turn: game ? turn : null,
      configured: relay?.configured ?? null,
      freeSeats: relay?.freeSeats ?? null,
      message: message || null,
    });
    return () => {
      delete window.render_game_to_text;
    };
  }, [game, searching, turn, relay, message]);

  const startSearch = useCallback(() => {
    setMessage('Looking for a Lichess player…');
    setSearching(true);
  }, []);

  const stopSearch = useCallback(async () => {
    searchingRef.current = false;
    setSearching(false);
    try {
      await cancelLichessSearch();
      setMessage('Search cancelled.');
    } catch (error) {
      setMessage(error.message);
    }
  }, []);

  const submitMove = useCallback(async (from, to, promotion) => {
    const current = gameRef.current;
    if (!current || !canMove) return;
    setPendingMove(true);
    setSelectedSquare(null);
    setPendingPromotion(null);
    try {
      const response = await sendLichessMove(current.gameId, from, to, promotion);
      noteServerTime(response);
      if (response?.game) setGame(response.game);
      if (!response?.warning) setMessage('');
    } catch (error) {
      setMessage(error.message);
      try {
        const refreshed = await readLichessGame(current.gameId);
        noteServerTime(refreshed);
        if (refreshed?.game) setGame(refreshed.game);
      } catch (_) {
        // Keep the move error on screen; the long-poll loop will resync.
      }
    } finally {
      if (mountedRef.current) setPendingMove(false);
    }
  }, [canMove, noteServerTime]);

  const onSquareClick = useCallback((square) => {
    if (!canMove) return;
    const clicked = chess.get(square);
    if (!selectedSquare) {
      if (clicked?.color === game.color) setSelectedSquare(square);
      return;
    }
    if (square === selectedSquare) {
      setSelectedSquare(null);
    } else if (clicked?.color === game.color) {
      setSelectedSquare(square);
    } else {
      const promoting = chess.get(selectedSquare)?.type === 'p' && (square[1] === '1' || square[1] === '8');
      if (promoting) setPendingPromotion({ from: selectedSquare, to: square, color: game.color });
      else submitMove(selectedSquare, square);
    }
  }, [canMove, chess, selectedSquare, game, submitMove]);

  const runAction = useCallback(async (action) => {
    const current = gameRef.current;
    if (!current) return;
    try {
      const response = await lichessGameAction(action, current.gameId);
      noteServerTime(response);
      if (response?.game) setGame(response.game);
    } catch (error) {
      setMessage(error.message);
    }
  }, [noteServerTime]);

  const leaveGame = useCallback(() => {
    setGame(null);
    setUrlGame(null);
    setMessage('');
  }, []);

  if (!game) {
    const unavailable = relay && !relay.configured;
    return (
      <div className="setup-view online-lobby">
        <h2>Play a Lichess Player</h2>
        <p className="online-help">
          Micro Chess seeks a real opponent in the public Lichess pool for you. No Lichess account, login, or sign-up —
          you stay anonymous and every game is casual (unrated).
        </p>
        <div className="setup-option">
          <label htmlFor="lichess-time-control">TIME CONTROL</label>
          <select
            id="lichess-time-control"
            className="level-select"
            value={timeControl}
            disabled={searching}
            onChange={(event) => setTimeControl(Number(event.currentTarget.value))}
          >
            {TIME_CONTROLS.map((control) => (
              <option value={control.value} key={control.value}>{control.label}</option>
            ))}
          </select>
        </div>
        {searching ? (
          <div className="queue-status">
            <p>Searching the Lichess pool for a {timeControl / 60}-minute game…</p>
            <button className="btn btn-secondary" onClick={stopSearch}>CANCEL</button>
          </div>
        ) : (
          <button className="start-btn" onClick={startSearch} disabled={unavailable}>FIND A LICHESS OPPONENT</button>
        )}
        {relay?.configured && (
          <p className="lichess-seats">
            {relay.freeSeats} of {relay.seatCount} relay seat{relay.seatCount === 1 ? '' : 's'} free
            {relay.accounts?.some((account) => account.error)
              ? ` — ${relay.accounts.find((account) => account.error).error}`
              : ''}
          </p>
        )}
        {onExit && <button className="btn btn-secondary lobby-back" onClick={onExit}>BACK</button>}
        {message && <p className="online-message" role="status">{message}</p>}
      </div>
    );
  }

  const whiteLabel = game.color === 'w' ? 'You (White)' : `${describeOpponent(game)} — White`;
  const blackLabel = game.color === 'b' ? 'You (Black)' : `${describeOpponent(game)} — Black`;
  const drawOffered = game.drawOfferBy && game.drawOfferBy !== game.color;

  return (
    <div className="container online-game">
      <div className="header">
        <h1>♟ Lichess Opponent ♟</h1>
        <div className="online-meta">
          <span className={'connection ' + (game.finished ? 'polling' : 'connected')}>
            {game.finished ? 'finished' : 'live'}
          </span>
          <span>{describeOpponent(game)}</span>
          <span>{game.rated ? 'rated' : 'casual'} · {game.speed || 'standard'}</span>
        </div>
      </div>
      <Clock label={blackLabel} value={relayClockRemaining(game, 'b', { now: clockNow, turn, skewMs: skewRef.current })} active={!game.finished && turn === 'b'} />
      <div className="board-container">
        <Board
          position={chess.board()}
          selectedSquare={selectedSquare}
          validMoves={validMoves}
          turn={turn}
          inCheck={chess.in_check()}
          flip={game.color === 'b'}
          rotatePieces={false}
          onSquareClick={onSquareClick}
        />
        <PromotionDialog
          visible={!!pendingPromotion}
          color={pendingPromotion?.color || 'w'}
          onChoose={(piece) => submitMove(pendingPromotion.from, pendingPromotion.to, piece)}
        />
      </div>
      <Clock label={whiteLabel} value={relayClockRemaining(game, 'w', { now: clockNow, turn, skewMs: skewRef.current })} active={!game.finished && turn === 'w'} />
      <div id="status" className={pendingMove ? 'thinking' : ''}>
        {pendingMove ? 'Sending move to Lichess…' : describeRelayResult(game, turn)}
      </div>
      {replayError && <p className="online-message" role="status">{replayError}</p>}
      {drawOffered && !game.finished && (
        <div className="draw-offer">
          {describeOpponent(game)} offered a draw.
          <button className="btn" onClick={() => runAction('accept_draw')}>ACCEPT DRAW</button>
          <button className="btn btn-secondary" onClick={() => runAction('decline_draw')}>DECLINE</button>
        </div>
      )}
      {!game.finished && (
        <div className="controls">
          <button className="btn btn-secondary" onClick={() => runAction('offer_draw')}>OFFER DRAW</button>
          {canAbortRelayGame(game) ? (
            <button className="btn" onClick={() => runAction('abort')}>ABORT</button>
          ) : (
            <button className="btn" onClick={() => runAction('resign')}>RESIGN</button>
          )}
        </div>
      )}
      {game.finished && (
        <div className="controls">
          <button className="start-btn" onClick={leaveGame}>NEW LICHESS GAME</button>
          {onExit && <button className="btn btn-secondary" onClick={onExit}>BACK</button>}
        </div>
      )}
      <p className="online-help">
        <a href={game.lichessUrl} target="_blank" rel="noreferrer noopener">View this game on lichess.org</a>
      </p>
      {message && <p className="online-message" role="status">{message}</p>}
    </div>
  );
}
