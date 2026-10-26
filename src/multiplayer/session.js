import { Chess } from 'chess.js';
import { control, newIdentity } from './client.js';
import { PeerConnection } from './connection.js';
import { encode, decode, TYPE } from './binary.js';
import { applyUci, positionDigest, replay, reconcile } from './history.js';
import { loadSession, storeSession } from './storage.js';
import { gameResult } from '../core/onlineGame.js';
import { PROTOCOL, TIMING, LIMITS } from './config.js';
import { transition } from './state.js';

const win=color=>color==='w'?'white_won':'black_won';
const lose=color=>color==='w'?'black_won':'white_won';
export class MultiplayerSession {
  constructor(onChange,{ timing=TIMING, storage={load:loadSession,save:storeSession}, api=control, Peer=PeerConnection }={}) {
    this.onChange=onChange; this.timing=timing; this.storage=storage; this.api=api; this.Peer=Peer;
    this.state='idle'; this.game=new Chess(); this.history=[]; this.ack=0; this.message='';
    this.serial=Promise.resolve(); this.saving=Promise.resolve(); this.disposed=false; this.epoch=0;
  }
  snapshot() {
    return { state:this.state, session:this.session, game:this.game, history:this.history,
      message:this.message, result:this.result, drawOffer:this.drawOffer,
      canMove:this.state==='active' && !this.pending && this.game.turn()===this.session?.color };
  }
  emit() { if (!this.disposed) this.onChange(this.snapshot()); }
  setState(state,message='') { this.state=transition(this.state,state); this.message=message; this.emit(); }
  save() {
    const value=this.session ? { session:{...this.session}, history:this.history.map(m=>({...m})),fen:this.game.fen(),ack:this.ack,result:this.result } : null;
    this.saving=this.saving.then(()=>this.storage.save(value));
    return this.saving;
  }
  async lockSeat() {
    if (!navigator.locks) throw new Error('Your browser cannot safely recover this game. Use a current browser.');
    await new Promise((resolve,reject)=>{
      navigator.locks.request('microchess-'+this.session.playerId,{ifAvailable:true},async lock=>{
        if (!lock) { reject(new Error('This game is already open in another tab.')); return; }
        resolve(); await new Promise(done=>{this.unlock=done;});
      }).catch(reject);
    });
  }
  async restore() {
    const saved=await this.storage.load();
    if (!saved) return false;
    this.session=saved.session;
    try { await this.lockSeat(); }
    catch(error) { this.session=null; throw error; }
    const restored=await replay(saved.history); this.game=restored.game; this.history=restored.history; this.ack=saved.ack;
    if (saved.fen!==this.game.fen()) throw new Error('Temporary game data is invalid');
    if (!this.session.gameId) {
      this.state='matchmaking'; this.pollQueue(); return true;
    }
    if (saved.result) { this.result=saved.result; this.setState('error'); this.setState('finishing','Finishing game…'); await this.finalize(); }
    else if (!this.session.opponentId) { this.state='waiting'; this.emit(); this.pollWaiting(); }
    else { await this.reconnect(); }
    return true;
  }
  async start(action,roomId) {
    if (this.state!=='idle') return;
    this.setState(action==='room'?'creating-room':action==='join'?'joining':'matchmaking',action==='room'?'Creating room…':action==='join'?'Joining room…':'Finding opponent…');
    this.session=newIdentity();
    try {
      await this.lockSeat();
      const response=await this.api(action,this.session,{roomId});
      if (this.disposed) return;
      if (action==='matchmaking' && response.status==='waiting') { await this.save(); this.pollQueue(); return; }
      await this.acceptRoom(response);
    } catch (error) { this.fail(error); }
  }
  async acceptRoom(response) {
    Object.assign(this.session,response); await this.save();
    if (response.status==='waiting') { this.setState('waiting','Waiting for opponent…'); this.pollWaiting(); }
    else await this.connect();
  }
  async pollQueue() {
    const epoch=this.epoch;
    try {
      const response=await this.api('matchmaking/status',this.session);
      if (this.disposed || epoch!==this.epoch) return;
      if (response.gameId) { await this.acceptRoom(response); return; }
      if (response.status!=='waiting') { await this.clear(); this.setState('idle','Matchmaking expired.'); return; }
      this.pollTimer=setTimeout(()=>this.pollQueue(),this.timing.poll*2);
    } catch(error) { this.fail(error); }
  }
  async cancel() {
    if (this.state!=='matchmaking') return;
    const response=await this.api('cancel',this.session);
    this.epoch++; clearTimeout(this.pollTimer);
    if (response.gameId) return this.acceptRoom(response);
    await this.clear(); this.setState('idle','Matchmaking cancelled.');
  }
  async pollWaiting() {
    try {
      const response=await this.api('status',this.session);
      if (this.disposed) return;
      Object.assign(this.session,response);
      if (response.status==='expired') throw new Error('Room expired');
      if (response.opponentId) { await this.connect(); return; }
      this.pollTimer=setTimeout(()=>this.pollWaiting(),this.timing.poll*2);
    } catch(error) { this.fail(error); }
  }
  async connect() {
    if (this.disposed) return;
    clearTimeout(this.pollTimer); this.peer?.close(); this.hello=false; this.ready=false; this.pending=null;
    this.setState('signaling','Opponent joined. Connecting…');
    const epoch=++this.epoch;
    this.peer=new this.Peer(this.session,{
      onOpen:()=>this.enqueue(()=>this.open(),epoch),
      onMessage:data=>this.enqueue(()=>this.receive(data),epoch),
      onDisconnect:()=>{ if(epoch===this.epoch) this.disconnected(); },
      onError:error=>{ if(epoch===this.epoch) this.fail(error); },
    },this.timing);
    this.setState('connecting','Connecting…');
    await this.peer.start();
  }
  enqueue(fn,epoch=this.epoch) {
    this.serial=this.serial.then(()=>{ if(!this.disposed && epoch===this.epoch) return fn(); }).catch(error=>this.fail(error));
    return this.serial;
  }
  async open() {
    this.setState(this.session.generation>1?'resume-handshake':'handshaking','Connecting…');
    this.peer.send(JSON.stringify({type:'hello',protocol:PROTOCOL,gameId:this.session.gameId,playerId:this.session.playerId,
      color:this.session.color,generation:this.session.generation,history:this.history,fen:this.game.fen(),lastSeq:this.history.length,
      digest:await positionDigest(this.game,this.history)}));
  }
  async handshake(data) {
    if (!['handshaking','resume-handshake'].includes(this.state) || data.length>LIMITS.body) throw new Error('Unexpected connection message');
    const message=JSON.parse(data);
    if (message.protocol!==PROTOCOL || message.gameId!==this.session.gameId || message.generation!==this.session.generation) throw new Error('Game identity mismatch');
    if (message.type==='hello') {
      if(this.hello || message.playerId!==this.session.opponentId || message.color===this.session.color || !['w','b'].includes(message.color)) throw new Error('Player identity mismatch');
      const remote=await replay(message.history);
      if(message.fen!==remote.game.fen() || message.lastSeq!==message.history.length || message.digest!==await positionDigest(remote.game,remote.history)) throw new Error('Position mismatch');
      const common=await reconcile(this.history,message.history);
      this.game=common.game; this.history=common.history; this.ack=this.history.length; this.hello=true;
      await this.save();
      this.peer.send(JSON.stringify({type:'ready',protocol:PROTOCOL,gameId:this.session.gameId,generation:this.session.generation,
        fen:this.game.fen(),lastSeq:this.history.length,digest:await positionDigest(this.game,this.history)}));
    } else if(message.type==='ready') {
      if(!this.hello || this.ready || message.lastSeq!==this.history.length || message.fen!==this.game.fen() || message.digest!==await positionDigest(this.game,this.history)) throw new Error('Position mismatch');
      this.ready=true;
      this.peer.stopSignaling();
      await this.api('ready',this.session);
      this.setState('active',this.session.generation>1?'Game resumed.':'Connected');
      this.lastPong=Date.now(); this.turnSince=Date.now(); this.lastInteraction=0; this.challenge=null;
      this.reconnectLimit=null;
      this.healthTimer=setInterval(()=>this.tick(),Math.min(this.timing.heartbeat,1000));
      this.lastPing=0;
    } else throw new Error('Unknown connection message');
  }
  send(type,payload={},seq=this.history.length) { this.peer.send(encode(type,seq,payload)); }
  async move(from,to,promotion) {
    if(!this.snapshot().canMove) return false;
    this.pending={processing:true}; this.emit();
    try {
      if(this.history.length>=LIMITS.moves) throw new Error('This game has reached the move limit.');
      const uci=from+to+(promotion || '');
      const move=applyUci(this.game,uci); this.history.push({uci,san:move.san,digest:''});
      const digest=await positionDigest(this.game,this.history); this.history[this.history.length-1].digest=digest;
      this.pending={seq:this.history.length,digest,sent:Date.now()};
      await this.save(); this.send(TYPE.MOVE,{uci,digest}); this.turnSince=Date.now(); this.challenge=null; this.emit();
      return true;
    } catch(error) {
      if (/Connection lost|Connection is busy/.test(error.message)) this.disconnected();
      else { this.pending=null; this.fail(error); }
      return false;
    }
  }
  async receive(data) {
    if(this.state==='finished') return;
    if(typeof data==='string') return this.handshake(data);
    const packet=decode(data), {type,seq}=packet;
    if(!['active','connection-grace','finishing'].includes(this.state)) throw new Error('Unexpected game packet');
    if(type===TYPE.MOVE) {
      if(seq===this.history.length && this.history[seq-1]?.uci===packet.uci && this.history[seq-1]?.digest===packet.digest) {
        this.send(TYPE.MOVE_ACK,{digest:packet.digest},seq); return;
      }
      if((this.state!=='active' && !(this.state==='finishing' && this.resignation)) || seq!==this.history.length+1 || this.game.turn()===this.session.color || this.pending) throw new Error('Invalid move sequence or turn');
      const move=applyUci(this.game,packet.uci);
      this.history.push({uci:packet.uci,san:move.san,digest:packet.digest});
      if(await positionDigest(this.game,this.history)!==packet.digest) {
        this.history.pop(); this.game.undo(); throw new Error('Position mismatch');
      }
      this.ack=seq; await this.save(); this.send(TYPE.MOVE_ACK,{digest:packet.digest});
      this.drawOffer=null; this.turnSince=Date.now(); this.challenge=null; this.emit();
      const result=gameResult(this.game); if(result) this.proposeEnd(result);
      return;
    }
    if(type===TYPE.MOVE_ACK) {
      if(seq<=this.ack && this.history[seq-1]?.digest===packet.digest) return;
      if(!this.pending || seq!==this.pending.seq || packet.digest!==this.pending.digest) throw new Error('Invalid move acknowledgement');
      this.ack=seq; this.pending=null; await this.save(); this.emit();
      const result=gameResult(this.game); if(result) this.proposeEnd(result);
      return;
    }
    if(type===TYPE.PING) { this.send(TYPE.PONG); return; }
    if(type===TYPE.PONG) {
      this.lastPong=Date.now();
      if(this.state==='connection-grace' && this.ready && this.peer.channel?.readyState==='open') {
        clearTimeout(this.graceTimer); this.setState('active','Connection restored.');
        this.healthTimer=setInterval(()=>this.tick(),Math.min(this.timing.heartbeat,1000));
      }
      return;
    }
    if(type===TYPE.RESIGN) {
      this.resignation=true; this.expectedResult=win(this.session.color); this.proposeEnd(this.expectedResult); return;
    }
    if(type===TYPE.DRAW_OFFER || type===TYPE.DRAW_DECLINE) {
      if(this.state==='active' && seq===this.history.length) { this.drawOffer=type===TYPE.DRAW_OFFER?'opponent':null; this.emit(); }
      return;
    }
    if(![TYPE.ACTIVITY_PROBE,TYPE.ACTIVITY_ACK,TYPE.GAME_OVER,TYPE.GAME_OVER_ACK].includes(type) && seq!==this.history.length) throw new Error('Invalid packet sequence');
    if(type===TYPE.GAME_OVER_ACK) {
      if(this.state==='finished') return;
      if(this.state!=='finishing' || packet.result!==this.result) throw new Error('Invalid game result');
      await this.finalize(); return;
    }
    if(type===TYPE.GAME_OVER) {
      if(this.challenge && Date.now()>=this.challenge.deadline) this.expectedResult=this.challenge.role==='probe'?win(this.session.color):lose(this.session.color);
      if(packet.result!==this.expectedResult && packet.result!==gameResult(this.game) && packet.result!==this.result) throw new Error('Unverified game result');
      this.send(TYPE.GAME_OVER_ACK,{result:packet.result});
      if(this.state!=='finishing') this.setState('finishing','Game finished.');
      this.result=packet.result; await this.finalize(); return;
    }
    if(this.state!=='active') return;
    if(type===TYPE.DRAW_ACCEPT) {
      if(this.drawOffer!=='self') throw new Error('No draw offer');
      this.expectedResult='draw'; this.proposeEnd('draw');
    } else if(type===TYPE.ACTIVITY_PROBE) {
      if(this.game.turn()!==this.session.color) throw new Error('Invalid activity challenge');
      if(this.challenge || Date.now()-this.turnSince<this.timing.inactivity*0.99) throw new Error('Premature activity challenge');
      this.challenge={role:'respond',deadline:Date.now()+this.timing.presence,id:seq};
      this.message='Still there? Interact with the board to continue.'; this.emit();
    } else if(type===TYPE.ACTIVITY_ACK) {
      if(this.challenge?.role!=='probe' || seq!==this.challenge.id || Date.now()>this.challenge.deadline) return;
      this.challenge=null; this.turnSince=Date.now();
    }
  }
  interact() {
    if(this.state!=='active') return;
    this.lastInteraction=Date.now();
    if(this.challenge?.role==='respond' && Date.now()<=this.challenge.deadline) {
      this.send(TYPE.ACTIVITY_ACK,{},this.challenge.id); this.challenge=null; this.turnSince=Date.now(); this.message=''; this.emit();
    }
  }
  draw(action) {
    if(this.state!=='active' || this.pending) return;
    if(action==='offer') { this.drawOffer='self'; this.send(TYPE.DRAW_OFFER); }
    if(action==='decline' && this.drawOffer==='opponent') { this.drawOffer=null; this.send(TYPE.DRAW_DECLINE); }
    if(action==='accept' && this.drawOffer==='opponent') { this.send(TYPE.DRAW_ACCEPT); this.expectedResult='draw'; this.proposeEnd('draw'); }
    this.emit();
  }
  resign() {
    if(this.state!=='active' || this.pending) return;
    this.resignation=true; this.send(TYPE.RESIGN); this.expectedResult=lose(this.session.color); this.proposeEnd(this.expectedResult);
  }
  tick() {
    if(this.state!=='active') return;
    try {
      const now=Date.now();
      if(now-this.lastPong>this.timing.health || (this.pending && now-this.pending.sent>this.timing.ack)) { this.disconnected(); return; }
      if(now-this.lastPing>this.timing.heartbeat) { this.send(TYPE.PING); this.lastPing=now; }
      if(!this.challenge && !this.pending && this.game.turn()!==this.session.color && now-this.turnSince>=this.timing.inactivity) {
        const id=crypto.getRandomValues(new Uint32Array(1))[0];
        this.challenge={role:'probe',deadline:now+this.timing.presence,id}; this.send(TYPE.ACTIVITY_PROBE,{},id);
      }
      if(this.challenge && now>this.challenge.deadline) {
        this.expectedResult=this.challenge.role==='probe' ? win(this.session.color) : lose(this.session.color);
        this.proposeEnd(this.expectedResult);
      }
    } catch { this.disconnected(); }
  }
  disconnected() {
    if(!['active','handshaking','resume-handshake','connecting'].includes(this.state)) return;
    clearInterval(this.healthTimer);
    this.setState('connection-grace','Opponent disconnected. Reconnecting…');
    this.graceTimer=setTimeout(()=>this.enqueue(()=>this.reconnect()),this.timing.grace);
  }
  async reconnect() {
    if(this.disposed) return;
    clearTimeout(this.graceTimer); clearInterval(this.healthTimer); this.peer?.close();
    this.setState('reconnecting','Reconnecting…');
    this.reconnectLimit=this.reconnectLimit || Date.now()+this.timing.reconnect;
    await this.save();
    let response;
    try { response=await this.api('reconnect',this.session,{checkpoint:{history:this.history,fen:this.game.fen(),ack:this.ack}}); }
    catch(error) { this.retryRecovery(()=>this.reconnect(),error); return; }
    if(this.disposed) return;
    Object.assign(this.session,response); await this.save();
    await this.pollReconnect();
  }
  retryRecovery(task,error) {
    if(this.disposed) return;
    if((error.status && error.status!==503 && error.status!==429) || Date.now()>this.reconnectLimit) throw error;
    this.pollTimer=setTimeout(()=>this.enqueue(task),this.timing.poll*2);
  }
  async pollReconnect() {
    let response;
    try { response=await this.api('reconnect/status',this.session); }
    catch(error) { this.retryRecovery(()=>this.pollReconnect(),error); return; }
    if(this.disposed) return;
    if(response.status==='expired') {
      if(!['w','b'].includes(response.winner)) throw new Error('Connection expired without a confirmed winner.');
      this.result=win(response.winner);
      this.setState('finishing','Opponent left the game.'); await this.finalize(); return;
    }
    if(Date.now()>this.reconnectLimit) throw new Error('Connection could not be restored.');
    Object.assign(this.session,response);
    if(response.opponentReturned) { await this.connect(); return; }
    this.pollTimer=setTimeout(()=>this.enqueue(()=>this.pollReconnect()),this.timing.poll*2);
  }
  proposeEnd(result) {
    if(this.state==='finishing' || this.state==='finished') return;
    clearInterval(this.healthTimer); this.result=result; this.setState('finishing','Game finished.');
    this.send(TYPE.GAME_OVER,{result});
    this.save().catch(e=>this.fail(e));
    this.finishTimer=setTimeout(()=>this.enqueue(()=>this.finalize()),this.timing.ack);
  }
  async finalize() {
    clearTimeout(this.finishTimer); clearInterval(this.healthTimer); clearTimeout(this.pollTimer);
    await this.save();
    const response=await this.api('finish',this.session,{result:this.result});
    if(response.status==='finished') {
      this.peer?.close();
      await this.clear(); if(this.state!=='finished') this.setState('finished','Game finished.');
    } else {
      this.message='Game finished. Confirming result…'; this.emit();
      this.finishTimer=setTimeout(()=>this.enqueue(()=>this.finalize()),this.timing.poll*2);
    }
  }
  async clear() {
    if(!this.session) return;
    this.saving=this.saving.catch(()=>{}).then(()=>this.storage.save(null));
    await this.saving; this.session=null; this.unlock?.(); this.unlock=null;
  }
  fail(error) {
    if(this.disposed) return;
    this.stopTimers(); this.peer?.close();
    const desync=/packet|sequence|mismatch|Illegal move|acknowledgement|Histories disagree|Unverified/.test(error.message);
    try { this.setState(desync && ['active','handshaking','resume-handshake'].includes(this.state)?'desynced':'error',error.message || 'Connection failed'); }
    catch { this.state='error'; this.message=error.message; this.emit(); }
    if([403,410].includes(error.status)) this.clear().catch(()=>{});
  }
  stopTimers() { clearTimeout(this.pollTimer); clearTimeout(this.graceTimer); clearTimeout(this.finishTimer); clearInterval(this.healthTimer); }
  dispose() { this.disposed=true; this.epoch++; this.stopTimers(); this.peer?.close(); this.unlock?.(); }
}
