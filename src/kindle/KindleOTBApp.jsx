import { useState, useCallback } from 'preact/hooks';
import { Board } from '../components/Board';
import { PromotionDialog } from '../components/PromotionDialog';
import { getGame, newGame, getSelection, selectSquare, clearSelection, isPromotion, makeMove, gameStatusText } from '../core/chessEngine';

export function KindleOTBApp() {
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
      <h1>♟ Over The Board ♟</h1>
      <div className="turn-indicator">
        Current Turn: <span>{turn === 'w' ? 'White' : 'Black'}</span>
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
      </div>
      <div className="status" id="status">
        {gameStatusText()}
      </div>
      <div>
        <button
          className="btn btn-primary"
          onClick={() => {
            newGame();
            setPending(null);
            rerender();
          }}
        >
          New Game
        </button>
        <button
          className="btn btn-secondary"
          onClick={() => {
            game.undo();
            clearSelection();
            rerender();
          }}
        >
          Undo Move
        </button>
      </div>
      <PromotionDialog visible={!!pending} color={pending ? pending.color : 'w'} onChoose={onPromote} />
    </div>
  );
}
