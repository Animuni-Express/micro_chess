import { useEffect, useRef, useState } from 'preact/hooks';
import { Board } from '../components/Board';
import { PromotionDialog } from '../components/PromotionDialog';
import { MultiplayerSession } from '../multiplayer/session';

// Dedicated e-ink presentation: the same block layout and controls as KindleStockfishApp.
export function KindleOnlineGameApp() {
  const controller = useRef(null);
  const [view, setView] = useState(null);
  const [code, setCode] = useState('');
  const [selected, setSelected] = useState(null);
  const [promotion, setPromotion] = useState(null);
  const [unsupported, setUnsupported] = useState(false);
  useEffect(function () {
    if (!window.RTCPeerConnection || !window.crypto || !window.crypto.subtle || !window.indexedDB || !navigator.locks) {
      setUnsupported(true);
      return;
    }
    const session = new MultiplayerSession(function (next) {
      setView(Object.assign({}, next));
      if (!next.canMove) { setSelected(null); setPromotion(null); }
    });
    controller.current = session;
    setView(session.snapshot());
    session.restore().catch(function (error) { session.fail(error); });
    return function () { session.dispose(); controller.current = null; };
  }, []);
  if (unsupported) return <div className="setup-view">
    <h2>Online Chess</h2>
    <p className="status" role="status">This browser cannot make the secure peer connection needed for online play. Local chess is still available.</p>
    <p><a href="over_the_board_kindle.html">Play Over The Board</a></p>
    <p><a href="stockfish_kindle.html">Play VS Stockfish</a></p>
  </div>;
  if (!view) return <div className="status" role="status">Loading...</div>;
  const session = controller.current;
  const game = view.game;
  const state = view.state;
  const busy = state !== 'idle';
  function run(action) { Promise.resolve().then(action).catch(function (error) { session.fail(error); }); }
  function fresh() { run(function () { return session.clear().then(function () { window.location.assign(window.location.pathname); }); }); }
  function submit(from, to, piece) {
    setSelected(null); setPromotion(null);
    run(function () { return session.move(from, to, piece); });
  }
  function click(square) {
    session.interact();
    if (!view.canMove) return;
    const piece = game.get(square);
    if (piece && piece.color === view.session.color) { setSelected(selected === square ? null : square); return; }
    if (!selected) return;
    const moves = game.moves({ square: selected, verbose: true });
    let legal = null;
    for (let i = 0; i < moves.length; i++) if (moves[i].to === square) legal = moves[i];
    if (!legal) { setSelected(null); return; }
    if (legal.flags.indexOf('p') !== -1) setPromotion({ from: selected, to: square, color: view.session.color });
    else submit(selected, square);
  }
  const result = view.result === 'draw' ? 'Game drawn.' : view.result === 'white_won' ? 'White wins.' : view.result === 'black_won' ? 'Black wins.' : '';
  if (!view.session || !view.session.gameId) return <div className="setup-view">
    <h2>Online Game Setup</h2>
    <p>Untimed chess with another player.</p>
    <div className="setup-option"><button className="start-btn" disabled={busy} onClick={function () { session.start('room'); }}>CREATE PRIVATE ROOM</button></div>
    <div className="setup-option">
      <label htmlFor="kindle_room_code">ROOM CODE:</label>
      <input id="kindle_room_code" aria-label="Room code" maxLength="6" value={code} disabled={busy} onInput={function (event) { setCode(event.currentTarget.value.toUpperCase()); }} />
      <button className="btn" disabled={busy || code.length !== 6} onClick={function () { session.start('join', code); }}>JOIN ROOM</button>
    </div>
    <div className="setup-option">{state === 'matchmaking' ? <button className="btn" onClick={function () { run(function () { return session.cancel(); }); }}>CANCEL SEARCH</button> : <button className="btn" disabled={busy} onClick={function () { session.start('matchmaking'); }}>FIND A MATCH</button>}</div>
    <p className="status" role="status">{result || view.message}</p>
    {(state === 'error' || state === 'finished') && <button className="btn" onClick={fresh}>NEW GAME</button>}
  </div>;
  return <div className="container">
    <h1>Online Chess</h1>
    <p>Room: <strong>{view.session.roomId}</strong></p>
    <p>You play {view.session.color === 'w' ? 'White' : 'Black'}.</p>
    <div className="status" id="status" role="status">{result || (state === 'active' ? (view.canMove ? 'Your move' : "Opponent's move") : view.message)}</div>
    {state === 'active' && view.message && <p role="status">{view.message}</p>}
    <div className="board-container">
      <Board position={game.board()} selectedSquare={view.canMove ? selected : null} validMoves={view.canMove && selected ? game.moves({ square: selected, verbose: true }) : []} turn={game.turn()} inCheck={game.in_check()} flip={view.session.color === 'b'} rotatePieces={false} onSquareClick={click} />
    </div>
    {view.drawOffer === 'opponent' && state === 'active' && <div><p>Opponent offered a draw.</p><button className="btn" onClick={function () { run(function () { session.draw('accept'); }); }}>ACCEPT DRAW</button><button className="btn" onClick={function () { run(function () { session.draw('decline'); }); }}>DECLINE</button></div>}
    {state === 'active' && <div><button className="btn" onClick={function () { run(function () { session.draw('offer'); }); }}>OFFER DRAW</button><button className="btn" onClick={function () { run(function () { session.resign(); }); }}>RESIGN</button></div>}
    {(state === 'finished' || state === 'error' || state === 'desynced') && <button className="btn" onClick={fresh}>NEW GAME</button>}
    <PromotionDialog visible={view.canMove && !!promotion} color={promotion ? promotion.color : 'w'} onChoose={function (piece) { if (promotion) submit(promotion.from, promotion.to, piece); }} />
  </div>;
}
