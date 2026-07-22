import { useState, useCallback, useEffect, useRef } from 'preact/hooks';
import { Board } from './Board';
import { PromotionDialog } from './PromotionDialog';
import { getGame, newGame, getSelection, selectSquare, clearSelection, isPromotion, makeMove, gameStatusText } from '../core/chessEngine';
import {
  initLocalStockfish,
  requestLocalMove,
  newLocalGame,
  isLocalStockfishReady,
  requestChessApiMove,
  requestLichessMove,
  requestSupabaseMove,
  fallbackMove,
} from '../core/stockfishClient';
import { loadScriptOnce } from '../core/lazyScript';

// Full 1-20 range, matching the original desktop AI-level slider.
const LEVELS = Array.from({ length: 20 }, (_, i) => i + 1);

// Setup menu (play-as colour, AI level 1-20, engine) + play view. Mirrors the
// Kindle Stockfish flow; the pre-Preact desktop page had the same menu and it
// was lost in the migration — this restores it.
export function StockfishApp() {
  const [, forceUpdate] = useState(0);
  const [phase, setPhase] = useState('setup');
  const [playerColor, setPlayerColor] = useState('w');
  const [aiLevel, setAiLevel] = useState(10);
  const [engine, setEngine] = useState('chessapi');
  const [pending, setPending] = useState(null);
  const [status, setStatus] = useState('');
  const thinking = useRef(false);
  const rerender = useCallback(() => forceUpdate((n) => n + 1), []);

  const game = getGame();
  const selection = getSelection();
  const turn = game.turn();

  const makeEngineMove = useCallback(() => {
    // Always re-fetch the live game — the `game` from the enclosing render can
    // be stale (this callback is memoized on [engine, aiLevel], but newGame()
    // swaps the module-level instance).
    const liveGame = getGame();
    if (liveGame.game_over() || thinking.current) return;
    thinking.current = true;
    setStatus('🤖 AI thinking…');

    const applyMove = (move) => {
      thinking.current = false;
      if (move) {
        makeMove(move.substring(0, 2), move.substring(2, 4), move.length > 4 ? move.substring(4, 5) : undefined);
      } else {
        // Engine unreachable (offline / blocked / rate-limited): never leave the
        // AI's turn stuck — play a simple heuristic move instead.
        const fb = fallbackMove(liveGame);
        if (fb) makeMove(fb.from, fb.to, fb.promotion);
      }
      setStatus('');
      rerender();
    };

    if (engine === 'local') {
      if (!isLocalStockfishReady()) {
        thinking.current = false;
        setTimeout(makeEngineMove, 400);
        return;
      }
      requestLocalMove(liveGame.fen(), aiLevel);
      return; // resolves via the onMove callback wired in initLocalStockfish
    }

    let request;
    if (engine === 'chessapi') {
      request = requestChessApiMove(liveGame.fen(), aiLevel);
    } else if (engine === 'lichess') {
      request = requestLichessMove(liveGame.fen());
    } else if (engine === 'supabase') {
      request = loadScriptOnce('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2')
        .then(() => loadScriptOnce('js/supabase_client.js'))
        .then(() => requestSupabaseMove(liveGame.fen(), Math.min(aiLevel, 15)));
    } else {
      request = Promise.resolve(null);
    }
    request.then(applyMove, () => applyMove(null));
  }, [engine, aiLevel]);

  useEffect(() => {
    if (phase !== 'playing') return;
    if (turn !== playerColor && !game.game_over()) makeEngineMove();
  }, [phase, turn]);

  const onSquareClick = useCallback(
    (square) => {
      if (game.game_over() || thinking.current || turn !== playerColor) return;
      const clicked = game.get(square);

      if (!selection.selectedSquare) {
        if (clicked && clicked.color === turn) {
          selectSquare(square);
          rerender();
        }
        return;
      }
      if (square === selection.selectedSquare) {
        clearSelection();
        rerender();
      } else if (clicked && clicked.color === turn) {
        selectSquare(square);
        rerender();
      } else if (isPromotion(selection.selectedSquare, square)) {
        setPending({ from: selection.selectedSquare, to: square, color: turn });
      } else {
        makeMove(selection.selectedSquare, square);
        rerender();
      }
    },
    [selection.selectedSquare, turn, playerColor]
  );

  const onPromote = useCallback(
    (type) => {
      if (!pending) return;
      makeMove(pending.from, pending.to, type);
      setPending(null);
      rerender();
    },
    [pending]
  );

  const startGame = useCallback(() => {
    newGame();
    setPending(null);
    setPhase('playing');
    if (engine === 'local') {
      setStatus('Loading engine…');
      initLocalStockfish(
        (from, to, promotion) => {
          thinking.current = false;
          makeMove(from, to, promotion);
          setStatus('');
          rerender();
        },
        () => {
          setStatus('');
          newLocalGame();
          rerender();
        }
      ).catch((err) => setStatus(err.message || 'Failed to load local engine'));
    } else {
      setStatus('');
    }
  }, [engine]);

  if (phase === 'setup') {
    return (
      <div className="container">
        <div className="header">
          <h1>🤖 Play vs Stockfish 🤖</h1>
        </div>
        <div className="setup-view">
          <h2>Game Setup</h2>
          <div className="setup-option">
            <label>PLAY AS:</label>
            <button className={'choice-btn' + (playerColor === 'w' ? ' active' : '')} onClick={() => setPlayerColor('w')}>
              WHITE
            </button>
            <button className={'choice-btn' + (playerColor === 'b' ? ' active' : '')} onClick={() => setPlayerColor('b')}>
              BLACK
            </button>
          </div>
          <div className="setup-option">
            <label htmlFor="ai-level">AI LEVEL (1-20):</label>
            <select id="ai-level" className="level-select" value={aiLevel} onChange={(e) => setAiLevel(parseInt(e.currentTarget.value, 10))}>
              {LEVELS.map((lvl) => (
                <option key={lvl} value={lvl}>
                  Level {lvl}
                </option>
              ))}
            </select>
          </div>
          <div className="setup-option">
            <label htmlFor="ai-engine">AI ENGINE:</label>
            <select id="ai-engine" className="level-select" value={engine} onChange={(e) => setEngine(e.currentTarget.value)}>
              <option value="chessapi">Chess-API (Cloud)</option>
              <option value="lichess">Lichess Cloud</option>
              <option value="supabase">Supabase Edge</option>
              <option value="local">Local Stockfish</option>
            </select>
          </div>
          <button className="start-btn" onClick={startGame}>
            START GAME
          </button>
        </div>
      </div>
    );
  }

  const statusText = thinking.current ? '🤖 AI thinking…' : status || gameStatusText(playerColor);

  return (
    <div className="container">
      <div className="header">
        <h1>🤖 Play vs Stockfish 🤖</h1>
        <div className="turn-indicator">
          Current Turn: <span>{turn === 'w' ? 'White' : 'Black'}</span>
        </div>
      </div>
      <div className="board-container">
        <Board
          position={game.board()}
          selectedSquare={selection.selectedSquare}
          validMoves={selection.validMoves}
          turn={turn}
          inCheck={game.in_check()}
          flip={playerColor === 'b'}
          rotatePieces={false}
          onSquareClick={onSquareClick}
        />
        <PromotionDialog visible={!!pending} color={pending ? pending.color : 'w'} onChoose={onPromote} />
      </div>
      <div id="status">{statusText}</div>
      <div className="controls">
        <button
          className="btn btn-secondary"
          onClick={() => {
            clearSelection();
            setPending(null);
            setPhase('setup');
          }}
        >
          Setup Game
        </button>
        <button
          className="btn btn-secondary"
          onClick={() => {
            const g = getGame();
            g.undo();
            g.undo();
            clearSelection();
            rerender();
          }}
        >
          Undo
        </button>
        <button
          className="btn btn-primary"
          onClick={() => {
            newGame();
            if (engine === 'local') newLocalGame();
            setPending(null);
            rerender();
          }}
        >
          Reset
        </button>
      </div>
    </div>
  );
}
