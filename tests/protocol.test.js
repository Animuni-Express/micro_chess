import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import { encode,decode,TYPE,squareIndex,squareName } from '../src/multiplayer/binary.js';
import { applyUci,positionDigest,replay,reconcile } from '../src/multiplayer/history.js';
import { transition } from '../src/multiplayer/state.js';
import { MultiplayerSession } from '../src/multiplayer/session.js';

async function historyFor(ucis) {
  const game=new Chess(), history=[];
  for(const uci of ucis) { applyUci(game,uci); history.push({uci,digest:''}); history.at(-1).digest=await positionDigest(game,history); }
  return {game,history};
}
test('all squares and all binary message types round trip in network order',()=>{
  for(let i=0;i<64;i++) assert.equal(squareIndex(squareName(i)),i);
  for(const type of Object.values(TYPE)) {
    const packet=decode(encode(type,0x01020304,{uci:'e7e8n',digest:'ab'.repeat(16),result:'draw'}));
    assert.equal(packet.seq,0x01020304); assert.equal(packet.type,type);
    if(type===TYPE.MOVE) assert.equal(packet.uci,'e7e8n');
  }
  assert.equal(encode(TYPE.MOVE,1,{uci:'e2e4',digest:'00'.repeat(16)}).byteLength,25);
});
test('malformed protocol, type, length, squares and promotion are rejected',()=>{
  for(const data of [new ArrayBuffer(0),new ArrayBuffer(26),'text']) assert.throws(()=>decode(data));
  for(const [offset,value] of [[0,2],[1,99],[6,64],[8,5]]) {
    const data=encode(TYPE.MOVE,1,{uci:'e2e4',digest:'00'.repeat(16)}); new DataView(data).setUint8(offset,value); assert.throws(()=>decode(data));
  }
  assert.throws(()=>decode(new ArrayBuffer(7)));
  assert.throws(()=>transition('idle','active'));
});
test('digest replay preserves complete history and reconciliation drops unmatched tail',async()=>{
  const a=await historyFor(['e2e4','e7e5','g1f3']);
  const b=await historyFor(['e2e4','e7e5']);
  const common=await reconcile(a.history,b.history);
  assert.equal(common.game.fen(),b.game.fen());
  assert.equal((await replay(a.history)).game.fen(),a.game.fen());
  const bad=structuredClone(a.history);bad[1].digest='00'.repeat(16);await assert.rejects(replay(bad));
  const other=await historyFor(['d2d4']);await assert.rejects(reconcile(a.history,other.history));
});
test('chess regression: legal/illegal moves, capture, castle, en passant, promotion, check and draws',()=>{
  const game=new Chess();assert.equal(game.move({from:'e2',to:'e5'}),null);
  for(const uci of ['e2e4','e7e5','g1f3','b8c6','f1c4','g8f6','e1g1']) applyUci(game,uci);
  assert.equal(game.get('f1').type,'r');
  const ep=new Chess();for(const uci of ['e2e4','a7a6','e4e5','d7d5','e5d6']) applyUci(ep,uci);
  assert.equal(ep.get('d5'),null);assert.equal(ep.get('d6').color,'w');
  const promotion=new Chess('7k/P7/8/8/8/8/8/7K w - - 0 1');applyUci(promotion,'a7a8q');assert.equal(promotion.get('a8').type,'q');assert.equal(promotion.in_check(),true);
  const mate=new Chess();for(const uci of ['f2f3','e7e5','g2g4','d8h4']) applyUci(mate,uci);assert.equal(mate.in_checkmate(),true);
  assert.equal(new Chess('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1').in_stalemate(),true);
  assert.equal(new Chess('7k/8/7K/8/8/8/8/8 w - - 0 1').in_draw(),true);
  assert.equal(new Chess('7k/8/8/8/8/8/R7/7K w - - 100 51').in_draw(),true);
  const repeat=new Chess();for(let i=0;i<2;i++)for(const uci of ['g1f3','g8f6','f3g1','f6g8'])applyUci(repeat,uci);assert.equal(repeat.in_threefold_repetition(),true);
});
function activeSession() {
  const calls=[],sent=[];
  const session=new MultiplayerSession(()=>{},{storage:{save:async()=>{},load:async()=>null},api:async(...args)=>{calls.push(args);return {status:'finished'};}});
  session.state='active';session.session={color:'w'};session.peer={send:data=>sent.push(data),close(){},stopSignaling(){}};
  session.ready=true; session.lastPong=Date.now();session.lastPing=Date.now();session.turnSince=Date.now();
  return {session,calls,sent};
}
test('normal move, ACK and crossing heartbeats make zero backend calls',async()=>{
  const {session,calls,sent}=activeSession();
  await session.move('e2','e4');assert.equal(decode(sent[0]).type,TYPE.MOVE);
  await session.receive(encode(TYPE.PING,0));await session.receive(encode(TYPE.PONG,0));
  const digest=session.history[0].digest;
  await session.receive(encode(TYPE.MOVE_ACK,1,{digest}));assert.equal(session.ack,1);
  await session.receive(encode(TYPE.MOVE_ACK,1,{digest}));assert.equal(session.state,'active');
  assert.equal(calls.length,0);session.dispose();
});
test('wrong turn, future sequence, bad digest and illegal remote move fail safely',async()=>{
  for(const uci of ['e2e4','e7e5']) {
    const {session}=activeSession();
    await assert.rejects(session.receive(encode(TYPE.MOVE,1,{uci,digest:'00'.repeat(16)})));
    session.dispose();
  }
  const {session}=activeSession();session.session.color='b';
  await assert.rejects(session.receive(encode(TYPE.MOVE,2,{uci:'e2e4',digest:'00'.repeat(16)})));
  await assert.rejects(session.receive(encode(TYPE.MOVE,1,{uci:'e2e4',digest:'00'.repeat(16)})));
  assert.equal(session.history.length,0);assert.equal(session.game.turn(),'w');session.dispose();
});
test('presence never auto ACKs and cannot be challenged prematurely',async()=>{
  const {session,sent}=activeSession();
  await assert.rejects(session.receive(encode(TYPE.ACTIVITY_PROBE,7)));
  session.turnSince=Date.now()-session.timing.inactivity;
  await session.receive(encode(TYPE.ACTIVITY_PROBE,7));assert.equal(sent.length,0);
  session.interact();assert.equal(decode(sent[0]).type,TYPE.ACTIVITY_ACK);assert.equal(decode(sent[0]).seq,7);
  session.dispose();
});
test('late terminal packets after cleanup are harmless',async()=>{
  const {session}=activeSession();session.state='finished';session.session=null;
  await session.receive(encode(TYPE.GAME_OVER_ACK,0,{result:'draw'}));assert.equal(session.state,'finished');session.dispose();
});
test('resignation can cross an already transmitted move',async()=>{
  const a=activeSession(),b=activeSession();b.session.session.color='b';
  await a.session.move('e2','e4');
  b.session.resign();
  await b.session.receive(a.sent[0]);
  await a.session.receive(b.sent[0]);
  assert.equal(a.session.state,'finishing');assert.equal(b.session.state,'finishing');
  assert.equal(a.session.result,'white_won');assert.equal(b.session.result,'white_won');
  assert.equal(a.session.game.fen(),b.session.game.fen());a.session.dispose();b.session.dispose();
});
test('inactivity expiry validates result even before the next local timer tick',async()=>{
  const {session,sent}=activeSession();
  session.turnSince=Date.now()-session.timing.inactivity;
  await session.receive(encode(TYPE.ACTIVITY_PROBE,42));
  await session.receive(encode(TYPE.PING,0));assert.equal(decode(sent[0]).type,TYPE.PONG);
  assert.equal(sent.filter(data=>decode(data).type===TYPE.ACTIVITY_ACK).length,0);
  session.challenge.deadline=Date.now()-1;
  await session.receive(encode(TYPE.GAME_OVER,0,{result:'black_won'}));
  assert.equal(session.result,'black_won');assert.equal(session.state,'finished');session.dispose();
});
test('five-minute turn inactivity starts the deliberate presence window',()=>{
  const {session,sent}=activeSession();
  session.session.color='b'; session.turnSince=Date.now()-session.timing.inactivity;
  session.tick();assert.equal(decode(sent[0]).type,TYPE.ACTIVITY_PROBE);assert.equal(session.challenge.role,'probe');
  session.challenge.deadline=Date.now()-1;session.tick();
  assert.equal(session.result,'black_won');assert.equal(session.state,'finishing');session.dispose();
});
test('temporary network failure keeps recovery alive within its finite deadline',async()=>{
  const {session}=activeSession();session.api=async()=>{throw new TypeError('Failed to fetch');};
  await session.reconnect();assert.equal(session.state,'reconnecting');assert.ok(session.pollTimer);
  session.reconnectLimit=Date.now()-1;await assert.rejects(session.reconnect());session.dispose();
});
test('cleanup is ordered after any pending local autosave',async()=>{
  const writes=[];const {session}=activeSession();
  session.storage.save=async value=>{writes.push(value);};
  const pending=session.save();await session.clear();await pending;
  assert.equal(writes.at(-1),null);session.dispose();
});
