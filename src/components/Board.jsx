import { pieceIcon } from '../core/pieces';

function squareName(row, col) {
  return String.fromCharCode(97 + col) + (8 - row);
}

function kingInCheckSquare(position, turn) {
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = position[r][c];
      if (p && p.type === 'k' && p.color === turn) return squareName(r, c);
    }
  }
  return null;
}

// `flip`: true when the human is playing Black and the board should be
// shown from Black's side. `rotatePieces`: rotate Black pieces 180deg for
// pass-and-play (over-the-board) so they face the opponent.
export function Board({ position, selectedSquare, validMoves, turn, inCheck, flip, rotatePieces, onSquareClick }) {
  const rows = flip ? [7, 6, 5, 4, 3, 2, 1, 0] : [0, 1, 2, 3, 4, 5, 6, 7];
  const cols = flip ? [7, 6, 5, 4, 3, 2, 1, 0] : [0, 1, 2, 3, 4, 5, 6, 7];
  const validTargets = new Set((validMoves || []).map((m) => m.to));
  const checkSquare = inCheck ? kingInCheckSquare(position, turn) : null;

  return (
    <table id="board" className="board">
      {rows.map((row) => (
        <tr key={row}>
          {cols.map((col) => {
            const sq = squareName(row, col);
            const piece = position[row][col];
            const classes = [(row + col) % 2 === 0 ? 'light' : 'dark'];
            if (validTargets.has(sq)) classes.push('valid-move');
            if (sq === selectedSquare) classes.push('selected');
            if (sq === checkSquare) classes.push('check-highlight');

            return (
              <td key={sq} className={classes.join(' ')} data-square={sq} onClick={() => onSquareClick(sq)}>
                {piece && (
                  <img
                    src={pieceIcon(piece.color, piece.type)}
                    alt={(piece.color === 'w' ? 'White' : 'Black') + piece.type.toUpperCase()}
                    draggable={false}
                    className={rotatePieces && piece.color === 'b' ? 'black-piece' : undefined}
                    style={rotatePieces && piece.color === 'b' ? { transform: 'rotate(180deg)' } : undefined}
                  />
                )}
              </td>
            );
          })}
        </tr>
      ))}
    </table>
  );
}
