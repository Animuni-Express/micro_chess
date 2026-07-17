import { useState, useCallback, useEffect, useRef } from 'preact/hooks';
import { Board } from '../components/Board';
import { PromotionDialog } from '../components/PromotionDialog';
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

export function KindleStockfishApp() {
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

  const makeEngineMove = useCallback(async () => {
    // Always re-fetch the live game — `game` from the enclosing render can be
    // stale here (this callback is memoized on [engine, aiLevel], which don't
    // change across a newGame() reset, but the module-level instance does).
    const game = getGame();
    if (game.game_over() || thinking.current) return;
    thinking.current = true;
    setStatus('🤖 AI thinking…');

    let move = null;
    try {
      if (engine === 'local') {
        if (!isLocalStockfishReady()) {
          thinking.current = false;
          setTimeout(makeEngineMove, 400);
          return;
        }
        requestLocalMove(game.fen(), aiLevel);
        return; // resolves via onMove callback wired in initLocalStockfish
      } else if (engine === 'chessapi') {
        move = await requestChessApiMove(game.fen(), aiLevel);
      } else if (engine === 'lichess') {
        move = await requestLichessMove(game.fen());
      } else if (engine === 'supabase') {
        await loadScriptOnce('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2');
        await loadScriptOnce('js/supabase_client.js');
        move = await requestSupabaseMove(game.fen(), Math.min(aiLevel, 15));
      }
    } catch {
      move = null;
    }

    thinking.current = false;
    if (move) {
      makeMove(move.substring(0, 2), move.substring(2, 4), move.length > 4 ? move.substring(4, 5) : undefined);
    } else {
      const fb = fallbackMove(game);
      if (fb) makeMove(fb.from, fb.to, fb.promotion);
    }
    setStatus('');
    rerender();
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
      if (clicked && clicked.color === turn) {
        selectSquare(square);
        rerender();
      } else if (square === selection.selectedSquare) {
        clearSelection();
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
          <label>AI LEVEL (1-20):</label>
          <select className="level-select" value={aiLevel} onChange={(e) => setAiLevel(parseInt(e.target.value, 10))}>
            {[1, 5, 10, 15, 20].map((lvl) => (
              <option key={lvl} value={lvl}>
                Level {lvl}
              </option>
            ))}
          </select>
        </div>
        <div className="setup-option">
          <label>AI ENGINE:</label>
          <select className="level-select" value={engine} onChange={(e) => setEngine(e.target.value)}>
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
    );
  }

  return (
    <div className="container">
      <h1>VS Stockfish</h1>
      <div className="status" id="status">
        {status || gameStatusText(playerColor)}
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
      </div>
      <div>
        <button className="btn" onClick={() => setPhase('setup')}>
          Setup Game
        </button>
        <button
          className="btn"
          onClick={() => {
            game.undo();
            clearSelection();
            rerender();
          }}
        >
          Undo
        </button>
      </div>
      <PromotionDialog visible={!!pending} color={pending ? pending.color : 'w'} onChoose={onPromote} />
    </div>
  );
}
