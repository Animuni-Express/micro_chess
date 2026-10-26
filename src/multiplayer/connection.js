import { control } from './client.js';
import { TIMING } from './config.js';

export class PeerConnection {
  constructor(session, { onOpen, onMessage, onDisconnect, onError }, timing = TIMING) {
    this.session=session; this.callbacks={onOpen,onMessage,onDisconnect,onError}; this.timing=timing;
    this.abort=new AbortController(); this.cursor=0; this.candidates=[]; this.closed=false; this.polling=true;
    this.pc=new RTCPeerConnection({ iceServers:session.iceServers || [{urls:'stun:stun.l.google.com:19302'}] });
    this.pc.onicecandidate=event=>{
      if (event.candidate && this.polling) this.signal('candidate',event.candidate.toJSON()).catch(e=>this.fail(e));
    };
    this.pc.onconnectionstatechange=()=>{
      if (['failed','disconnected','closed'].includes(this.pc.connectionState) && !this.closed) onDisconnect();
    };
    this.pc.oniceconnectionstatechange=()=>{
      if (['failed','disconnected'].includes(this.pc.iceConnectionState) && !this.closed) onDisconnect();
    };
    this.pc.ondatachannel=event=>this.attach(event.channel);
  }
  fail(error) {
    if (!this.closed && !this.abort.signal.aborted) this.callbacks.onError(error.status?error:new Error('Connection failed. Please try again.'));
  }
  signal(kind,payload) { return control('signal',this.session,{ kind,payload,target:this.session.opponentId },this.abort.signal); }
  attach(channel) {
    if (this.channel || channel.label!=='microchess' || !channel.ordered || channel.maxRetransmits!==null || channel.maxPacketLifeTime!==null) {
      channel.close(); this.fail(new Error('Invalid connection channel')); return;
    }
    this.channel=channel; channel.binaryType='arraybuffer';
    channel.onopen=()=>this.callbacks.onOpen();
    channel.onmessage=event=>this.callbacks.onMessage(event.data);
    channel.onclose=()=>{ if (!this.closed) this.callbacks.onDisconnect(); };
    channel.onerror=()=>{ if (!this.closed) this.callbacks.onDisconnect(); };
  }
  async start() {
    if (this.session.color==='w') {
      this.attach(this.pc.createDataChannel('microchess',{ordered:true}));
      const offer=await this.pc.createOffer(); await this.pc.setLocalDescription(offer);
      await this.signal('offer',{type:offer.type,sdp:offer.sdp});
    }
    this.poll().catch(error=>this.fail(error));
    this.deadline=setTimeout(()=>this.fail(new Error('Connection failed. Please try again.')),this.timing.signaling);
  }
  async poll() {
    if (!this.polling || this.closed) return;
    const { signals }=await control('signals',this.session,{after:this.cursor},this.abort.signal);
    for (const signal of signals) {
      if (!this.polling || this.closed) return;
      if (signal.kind==='candidate') {
        if (this.pc.remoteDescription) await this.pc.addIceCandidate(signal.payload);
        else this.candidates.push(signal.payload);
      } else {
        if ((signal.kind==='offer') !== (this.session.color==='b')) throw new Error('Invalid connection description');
        await this.pc.setRemoteDescription(signal.payload);
        for (const candidate of this.candidates) await this.pc.addIceCandidate(candidate);
        this.candidates=[];
        if (signal.kind==='offer') {
          const answer=await this.pc.createAnswer(); await this.pc.setLocalDescription(answer);
          await this.signal('answer',{type:answer.type,sdp:answer.sdp});
        }
      }
      this.cursor=Number(signal.id);
    }
    if (this.polling) this.timer=setTimeout(()=>this.poll().catch(e=>this.fail(e)),this.timing.poll);
  }
  send(data) {
    if (this.channel?.readyState!=='open') throw new Error('Connection lost');
    if (this.channel.bufferedAmount>65536) throw new Error('Connection is busy');
    this.channel.send(data);
  }
  stopSignaling() {
    this.polling=false; clearTimeout(this.timer); clearTimeout(this.deadline);
    this.abort.abort(); this.candidates=[];
  }
  close() {
    this.closed=true; this.stopSignaling();
    if (this.channel) {
      this.channel.onopen=this.channel.onmessage=this.channel.onclose=this.channel.onerror=null;
      this.channel.close();
    }
    this.pc.onconnectionstatechange=this.pc.oniceconnectionstatechange=this.pc.onicecandidate=this.pc.ondatachannel=null;
    this.pc.close();
  }
}
