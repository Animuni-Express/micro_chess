import { useState, useCallback } from 'preact/hooks';
import { Board } from './Board';
import { PromotionDialog } from './PromotionDialog';
import { getGame, newGame, getSelection, selectSquare, clearSelection, isPromotion, makeMove, undoMove, gameStatusText } from '../core/chessEngine';

export function OTBApp() {
  const [, forceUpdate] = useState(0);
  const [pending, setPending] = useState(null);
  const rerender = useCallback(() => forceUpdate((n) => n + 1), []);

  const game = getGame();
  const selection = getSelection();
  const turn = game.turn();

  const onSquareClick = useCallback(
    (square) => {
      if (game.game_over()) return;
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

  return (
    <div className="container">
      <div className="header">
        <h1>♟ Over The Board ♟</h1>
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
          flip={false}
          rotatePieces={true}
          onSquareClick={onSquareClick}
        />
        <PromotionDialog visible={!!pending} color={pending ? pending.color : 'w'} onChoose={onPromote} />
      </div>
      <div id="status">{gameStatusText()}</div>
      <div className="controls">
        <button
          id="undo"
          className="btn btn-secondary"
          onClick={() => {
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
