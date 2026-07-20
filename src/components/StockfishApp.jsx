import { useState, useCallback, useEffect, useRef } from 'preact/hooks';
import { Board } from './Board';
import { PromotionDialog } from './PromotionDialog';
import { getGame, newGame, getSelection, selectSquare, clearSelection, isPromotion, makeMove, undoMove, gameStatusText } from '../core/chessEngine';
import { initLocalStockfish, requestLocalMove, newLocalGame, isLocalStockfishReady, fallbackMove } from '../core/stockfishClient';

const PLAYER_COLOR = 'w';
const AI_LEVEL = 10;

export function StockfishApp() {
  const [, forceUpdate] = useState(0);
  const [pending, setPending] = useState(null);
  const [engineStatus, setEngineStatus] = useState('Loading engine…');
  const [engineFailed, setEngineFailed] = useState(false);
  const thinking = useRef(false);
  const rerender = useCallback(() => forceUpdate((n) => n + 1), []);

  const game = getGame();
  const selection = getSelection();
  const turn = game.turn();

  useEffect(() => {
    initLocalStockfish(
      (from, to, promotion) => {
        thinking.current = false;
        makeMove(from, to, promotion);
        rerender();
      },
      () => setEngineStatus('')
    ).catch((err) => {
      setEngineStatus(err.message || 'Failed to load engine');
      setEngineFailed(true);
    });
  }, []);

  // If the engine never loads (offline, CDN blocked), fall back to a simple
  // heuristic move instead of leaving the AI's turn stuck forever.
  useEffect(() => {
    if (turn === PLAYER_COLOR || game.game_over() || thinking.current) return;
    if (isLocalStockfishReady()) {
      thinking.current = true;
      requestLocalMove(game.fen(), AI_LEVEL);
    } else if (engineFailed) {
      const fb = fallbackMove(game);
      if (fb) makeMove(fb.from, fb.to, fb.promotion);
      setEngineStatus('');
      rerender();
    }
  }, [turn, engineFailed]);

  const onSquareClick = useCallback(
    (square) => {
      if (game.game_over() || thinking.current || turn !== PLAYER_COLOR) return;
      const clicked = game.get(square);

      if (!selection.selectedSquare) {
        if (clicked && clicked.color === turn) {
          selectSquare(square);
          rerender();
        }
        return;
      }
      if (square === selection.selectedSquare) {
        // must precede the own-piece branch, which would otherwise re-select
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
    [selection.selectedSquare, turn]
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

  const statusText = thinking.current ? '🤖 AI thinking…' : engineStatus || gameStatusText(PLAYER_COLOR);

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
          flip={PLAYER_COLOR === 'b'}
          rotatePieces={false}
          onSquareClick={onSquareClick}
        />
        <PromotionDialog visible={!!pending} color={pending ? pending.color : 'w'} onChoose={onPromote} />
      </div>
      <div id="status">{statusText}</div>
      <div className="controls">
        <button
          id="undo"
          className="btn btn-secondary"
          onClick={() => {
            undoMove();
            undoMove();
            rerender();
          }}
        >
          Undo
        </button>
        <button
          id="reset"
          className="btn btn-primary"
          onClick={() => {
            newGame();
            newLocalGame();
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
