import { useEffect, useRef, useState } from 'preact/hooks';
import { Board } from './Board';
import { PromotionDialog } from './PromotionDialog';
import { MultiplayerSession } from '../multiplayer/session';

export function OnlineGameApp() {
  const controller=useRef(null);
  const [view,setView]=useState(null);
  const [roomCode,setRoomCode]=useState('');
  const [selected,setSelected]=useState(null);
  const [promotion,setPromotion]=useState(null);
  const [notice,setNotice]=useState('');
  const [supported,setSupported]=useState(true);
  useEffect(()=>{
    if (!window.RTCPeerConnection || !window.crypto?.subtle || !window.indexedDB || !navigator.locks) { setSupported(false); return; }
    const session=new MultiplayerSession(next=>{
      setView({...next});
      if (!next.canMove) { setSelected(null); setPromotion(null); }
    });
    controller.current=session; setView(session.snapshot());
    session.restore().then(restored=>{
      if (!restored) {
        const code=new URLSearchParams(window.location.search).get('room');
        if (code) { setRoomCode(code); session.start('join',code.toUpperCase()); }
      }
    }).catch(error=>session.fail(error));
    return ()=>{ session.dispose(); controller.current=null; };
  },[]);
  useEffect(()=>{
    window.render_game_to_text=()=>JSON.stringify({screen:view?.session?.gameId?'game':'lobby',state:view?.state,
      roomId:view?.session?.roomId,color:view?.session?.color,fen:view?.game?.fen(),sequence:view?.history?.length,
      result:view?.result,message:view?.message});
    return ()=>{delete window.render_game_to_text;};
  },[view]);
  const run=fn=>Promise.resolve().then(fn).catch(error=>controller.current.fail(error));
  const session=controller.current;
  if (!supported) return <div className="setup-view"><h2>Online Chess</h2><p role="status">Online play needs a current browser with secure peer connections. You can still play over the board or against the local engine on this device.</p><a href="over_the_board_kindle.html">Play over the board</a></div>;
  if (!view) return <p role="status">Loading…</p>;
  const {state,game,canMove}=view;
  const busy=state!=='idle';
  const submit=(from,to,piece)=>run(async()=>{setSelected(null);setPromotion(null);await session.move(from,to,piece);});
  const click=square=>{
    session.interact();
    if (!canMove) return;
    const piece=game.get(square);
    if (piece?.color===view.session.color) { setSelected(selected===square?null:square); return; }
    if (!selected) return;
    const legal=game.moves({square:selected,verbose:true}).find(move=>move.to===square);
    if (!legal) {setSelected(null);return;}
    if (legal.flags.includes('p')) setPromotion({from:selected,to:square,color:view.session.color});
    else submit(selected,square);
  };
  const message=view.result ? (view.result==='draw'?'Game drawn.':view.result==='white_won'?'White wins.':'Black wins.') : view.message;
  const newGame=()=>run(async()=>{
    if (view.session) await session.clear();
    window.location.assign(window.location.pathname);
  });
  if (!view.session?.gameId) return <div className="setup-view online-lobby">
    <h2>Play Online</h2><p className="online-help">Untimed chess. Share a private room or find an opponent.</p>
    <button className="start-btn" disabled={busy} onClick={()=>session.start('room')}>CREATE PRIVATE ROOM</button>
    <form className="room-join" onSubmit={event=>{event.preventDefault();session.start('join',roomCode.trim().toUpperCase());}}>
      <input aria-label="Room code" required pattern="[A-HJ-KM-NP-Z2-9]{6}" maxLength="6" disabled={busy} value={roomCode} onInput={event=>setRoomCode(event.currentTarget.value.toUpperCase())} placeholder="ROOM CODE" />
      <button className="btn btn-secondary" disabled={busy}>JOIN ROOM</button>
    </form>
    <div className="online-divider"><span>OR</span></div>
    {state==='matchmaking'?<button className="btn btn-secondary" onClick={()=>run(()=>session.cancel())}>CANCEL</button>:<button className="btn online-match-button" disabled={busy} onClick={()=>session.start('matchmaking')}>FIND A MATCH</button>}
    {['error','finished'].includes(state) && <button className="btn btn-secondary" onClick={newGame}>NEW GAME</button>}
    <p className="online-message" role="status">{message}</p>
  </div>;
  return <div className="container online-game">
    <div className="header"><h1>♟ Online Chess ♟</h1><div className="online-meta"><span>Room {view.session.roomId}</span><span>You play {view.session.color==='w'?'White':'Black'}</span></div></div>
    {state==='waiting' && <div className="share-room"><strong>Share room code: {view.session.roomId}</strong><button className="btn btn-secondary" onClick={()=>run(async()=>{
      const url=new URL(window.location.pathname,window.location.origin);url.searchParams.set('room',view.session.roomId);
      if(navigator.clipboard) {await navigator.clipboard.writeText(url.href);setNotice('Invite link copied.');} else setNotice(url.href);
    })}>COPY LINK</button></div>}
    <div className="board-container" onKeyDown={event=>{if(event.isTrusted)session.interact();}}>
      <Board position={game.board()} selectedSquare={canMove?selected:null} validMoves={canMove && selected?game.moves({square:selected,verbose:true}):[]} turn={game.turn()} inCheck={game.in_check()} flip={view.session.color==='b'} rotatePieces={false} onSquareClick={click} />
      <PromotionDialog visible={canMove && !!promotion} color={promotion?.color || 'w'} onChoose={piece=>{if(promotion)submit(promotion.from,promotion.to,piece);}} />
    </div>
    <div id="status" role="status">{state==='active'?(canMove?'Your move':"Opponent's move"):message}</div>
    {state==='active' && <p className="online-message" role="status">{view.message}</p>}
    {view.drawOffer==='opponent' && state==='active' && <div className="draw-offer">Opponent offered a draw.<button className="btn" onClick={()=>run(()=>session.draw('accept'))}>ACCEPT DRAW</button><button className="btn btn-secondary" onClick={()=>run(()=>session.draw('decline'))}>DECLINE</button></div>}
    {state==='active' && <div className="controls"><button className="btn btn-secondary" onClick={()=>run(()=>session.draw('offer'))}>OFFER DRAW</button><button className="btn" onClick={()=>run(()=>session.resign())}>RESIGN</button></div>}
    {view.history.length>0 && <p aria-label="Moves">{view.history.map((move,index)=>(index%2===0?`${Math.floor(index/2)+1}. `:'')+move.san).join(' ')}</p>}
    {['finished','error','desynced'].includes(state) && <button className="btn" onClick={newGame}>NEW GAME</button>}
    {notice && <p role="status">{notice}</p>}
  </div>;
}
