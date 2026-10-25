import { test,before,after } from 'node:test';
import assert from 'node:assert/strict';
import { NetlifyDB } from '@netlify/database-dev';
import { newIdentity } from '../src/multiplayer/client.js';
import { handle } from '../netlify/edge-functions/multiplayer.js';

const db=new NetlifyDB({logger:()=>{}});
before(async()=>{await db.start();await db.applyMigrations('netlify/database/migrations');});
after(async()=>{await db.stop();});
let roomCounter=0;
async function call(action,session,extra={}) {
  const p={...session,...extra,tokenHash:session.sessionToken,rateKey:crypto.randomUUID(),newRoomId:'TST'+String(++roomCounter).padStart(3,'2'),newGameId:crypto.randomUUID()};
  const {rows}=await db.query('SELECT mc_control($1,$2::jsonb) AS result',[action,JSON.stringify(p)]);
  return rows[0].result;
}
async function pair() {
  const a=newIdentity(),b=newIdentity();Object.assign(a,await call('room',a));Object.assign(b,await call('join',b,{roomId:a.roomId}));
  Object.assign(a,await call('status',a));return {a,b};
}
test('create, atomic join race, duplicate join and invalid code',async()=>{
  const a=newIdentity();Object.assign(a,await call('room',a));
  const b=newIdentity(),c=newIdentity();
  const results=await Promise.all([call('join',b,{roomId:a.roomId}),call('join',c,{roomId:a.roomId})]);
  assert.equal(results.filter(r=>r.color==='b').length,1);assert.equal(results.filter(r=>r.code===409).length,1);
  Object.assign(b,results[0]);assert.equal((await call('join',b,{roomId:a.roomId})).playerId,b.playerId);
  assert.equal((await call('join',newIdentity(),{roomId:'XXXXXX'})).code,404);
});
test('queue matches exactly once, cancellation, expiry',async()=>{
  const a=newIdentity(),b=newIdentity(),c=newIdentity();
  assert.equal((await call('matchmaking',a)).status,'waiting');
  const results=await Promise.all([call('matchmaking',b),call('matchmaking',c)]);
  assert.equal(results.filter(r=>r.gameId).length,1);assert.equal(results.filter(r=>r.status==='waiting').length,1);
  const matched=await call('matchmaking/status',a);assert.equal(matched.gameId,results.find(r=>r.gameId).gameId);
  const waiter=results[0].status==='waiting'?b:c;assert.equal((await call('cancel',waiter)).status,'cancelled');
  const d=newIdentity();await call('matchmaking',d);await db.query("UPDATE mc_queue SET expires_at=now()-interval '1 second' WHERE player_id=$1",[d.playerId]);
  assert.equal((await call('matchmaking/status',d)).status,'expired');
});
test('signals use recipient, generation and cursor; ready purges signaling',async()=>{
  const {a,b}=await pair();
  assert.equal((await call('signal',a,{target:b.playerId,kind:'offer',payload:{type:'offer',sdp:'test'}})).status,'ok');
  const signals=(await call('signals',b,{after:0})).signals;assert.equal(signals.length,1);
  assert.equal((await call('signals',b,{after:Number(signals[0].id)})).signals.length,0);
  assert.equal((await call('signals',a,{after:0})).signals.length,0);
  assert.equal((await call('signal',a,{target:crypto.randomUUID(),kind:'candidate',payload:{candidate:'x'}})).code,409);
  await call('ready',a);await call('ready',b);
  assert.equal((await call('status',a)).status,'active');assert.equal((await call('signals',b,{after:0})).signals.length,0);
});
test('reconnect generation and ownership fence stale instances and restore both checkpoints',async()=>{
  const {a,b}=await pair();await call('ready',a);await call('ready',b);
  const old={...a}, checkpoint={history:[],fen:'start',ack:0};a.instanceId=crypto.randomUUID();
  Object.assign(a,await call('reconnect',a,{checkpoint}));assert.equal(a.generation,2);
  assert.equal((await call('reconnect',old,{checkpoint})).code,409);
  assert.equal((await call('status',old)).code,409);
  assert.equal((await call('reconnect/status',a)).opponentReturned,false);
  Object.assign(b,await call('reconnect',b,{checkpoint}));assert.equal(b.generation,2);
  assert.equal((await call('reconnect/status',a)).opponentReturned,true);
  assert.deepEqual((await call('reconnect/status',a)).checkpoint,checkpoint);
  assert.equal((await call('signal',{...b,generation:1},{target:a.playerId,kind:'offer',payload:{}})).code,409);
});
test('finish requires both seats, deletes cascading rows, and is idempotent',async()=>{
  const {a,b}=await pair();
  assert.equal((await call('finish',a,{result:'draw'})).status,'finishing');
  assert.equal((await call('status',b)).status,'finishing');
  assert.equal((await call('finish',b,{result:'draw'})).status,'finished');
  assert.equal((await call('finish',a,{result:'draw'})).status,'finished');
  assert.equal((await db.query('SELECT * FROM mc_seats WHERE room_id=$1',[a.roomId])).rows.length,0);
});
test('deadline abandonment and scheduled cleanup remove stale state',async()=>{
  const {a,b}=await pair();Object.assign(a,await call('reconnect',a,{checkpoint:{history:[],fen:'start',ack:0}}));
  await db.query("UPDATE mc_rooms SET reconnect_deadline=now()-interval '1 second' WHERE room_id=$1",[a.roomId]);
  assert.equal((await call('reconnect/status',a)).status,'expired');assert.equal((await call('finish',a,{result:'white_won'})).status,'finished');
  const d=newIdentity();Object.assign(d,await call('room',d));await db.query("UPDATE mc_rooms SET expires_at=now()-interval '1 second' WHERE room_id=$1",[d.roomId]);
  await call('cleanup',newIdentity());assert.equal((await call('status',d)).code,410);
});
test('late return loses and cannot reverse abandonment result',async()=>{
  const {a,b}=await pair();Object.assign(a,await call('reconnect',a,{checkpoint:{history:[],fen:'start',ack:0}}));
  await db.query("UPDATE mc_rooms SET reconnect_deadline=now()-interval '1 second' WHERE room_id=$1",[a.roomId]);
  const late=await call('reconnect',b,{checkpoint:{history:[],fen:'start',ack:0}});
  assert.equal(late.status,'expired');assert.equal(late.winner,'w');
  assert.equal((await call('finish',b,{result:'black_won'})).code,409);
  assert.equal((await call('finish',b,{result:'white_won'})).status,'finished');
});
test('HTTP boundary rejects invalid requests and uses actual SQL for valid creation',async()=>{
  const provider=()=>({sql:async(strings,...values)=>(await db.query('SELECT mc_control($1,$2::jsonb) AS result',values)).rows});
  assert.equal((await handle(new Request('http://localhost/api/multiplayer/room'),{},provider)).status,405);
  assert.equal((await handle(new Request('http://localhost/api/multiplayer/room',{method:'POST',body:'{}'}),{},provider)).status,400);
  const request=new Request('http://localhost/api/multiplayer/room',{method:'POST',body:JSON.stringify(newIdentity())});
  const response=await handle(request,{ip:'local'},provider);assert.equal(response.status,200);const created=await response.json();assert.equal(created.color,'w');assert.equal(created.roomId.length,6);
});
