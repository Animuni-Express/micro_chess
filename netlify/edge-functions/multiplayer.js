import { getDatabase } from '@netlify/database';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid=value=>typeof value==='string' && UUID.test(value);
const CODE = /^[A-HJ-KM-NP-Z2-9]{6}$/;
const GET = new Set(['status', 'matchmaking/status', 'signals', 'reconnect/status']);
const ACTIONS = new Set(['room','join','matchmaking','cancel','status','matchmaking/status','signal','signals','ready','reconnect','reconnect/status','finish']);
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const json = (value, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
async function hash(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2,'0')).join('');
}
async function iceServers(playerId) {
  const env=globalThis.Netlify?.env;
  const servers=[{urls:env?.get('MULTIPLAYER_STUN_URL') || 'stun:stun.l.google.com:19302'}];
  const secret=env?.get('MULTIPLAYER_TURN_SECRET'), urls=env?.get('MULTIPLAYER_TURN_URLS');
  if(secret && urls) {
    const username=Math.floor(Date.now()/1000+600)+':'+playerId;
    const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-1'},false,['sign']);
    const signature=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(username));
    const credential=btoa(String.fromCharCode(...new Uint8Array(signature)));
    servers.push({urls:JSON.parse(urls),username,credential});
  }
  return servers;
}
async function readBody(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Invalid request');
  const chunks = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 524288) { await reader.cancel(); throw new Error('Request too large'); }
    chunks.push(value);
  }
  const all = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { all.set(chunk,offset); offset+=chunk.length; }
  return JSON.parse(new TextDecoder().decode(all));
}
export async function handle(request, context, database = getDatabase) {
  const action = new URL(request.url).pathname.split('/api/multiplayer/')[1];
  if (!ACTIONS.has(action)) return json({ error: 'Not found' },404);
  if (request.method !== (GET.has(action) ? 'GET' : 'POST')) return json({ error: 'Method not allowed' },405);
  if (request.headers.get('origin') && request.headers.get('origin') !== new URL(request.url).origin) return json({ error: 'Origin denied' },403);
  let p;
  try {
    const sessionHeader=request.headers.get('x-microchess-session') || '{}';
    if(GET.has(action) && sessionHeader.length>4096) throw new Error('Request too large');
    p = GET.has(action) ? JSON.parse(sessionHeader) : await readBody(request);
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('Invalid request');
    for (const key of ['playerId','instanceId']) if (!isUuid(p[key])) throw new Error('Invalid session');
    if (typeof p.sessionToken!=='string' || !/^[0-9a-f]{64}$/.test(p.sessionToken)) throw new Error('Invalid session');
    if (!['room','matchmaking','matchmaking/status','cancel'].includes(action) && (typeof p.roomId!=='string' || !CODE.test(p.roomId))) throw new Error('Invalid room code');
    if (!['room','join','matchmaking','matchmaking/status','cancel'].includes(action)) {
      if (!isUuid(p.gameId) || !Number.isInteger(p.generation) || p.generation < 1 || p.generation>2147483647) throw new Error('Invalid session');
    }
    if (action==='signal') {
      if (!isUuid(p.target) || !['offer','answer','candidate'].includes(p.kind) || !p.payload || JSON.stringify(p.payload).length > 16384) throw new Error('Invalid connection message');
      if (p.kind!=='candidate' && (p.payload.type!==p.kind || typeof p.payload.sdp!=='string')) throw new Error('Invalid connection description');
      if (p.kind==='candidate' && typeof p.payload.candidate!=='string') throw new Error('Invalid candidate');
    }
    if (action==='signals' && (!Number.isSafeInteger(p.after) || p.after<0)) throw new Error('Invalid cursor');
    if (action==='reconnect') {
      const c=p.checkpoint;
      if (!c || !Array.isArray(c.history) || c.history.length>4096 || typeof c.fen!=='string' || c.fen.length>128 || !Number.isInteger(c.ack) || c.ack<0 || c.ack>c.history.length) throw new Error('Invalid checkpoint');
      for (const m of c.history) if (!m || typeof m.uci!=='string' || typeof m.digest!=='string' || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(m.uci) || !/^[a-f0-9]{32}$/.test(m.digest)) throw new Error('Invalid checkpoint');
    }
    if (action==='finish' && !['draw','white_won','black_won'].includes(p.result)) throw new Error('Invalid result');
  } catch (error) { return json({ error: error.message==='Request too large' ? error.message : 'Invalid request' }, error.message==='Request too large'?413:400); }
  try {
    const bytes=crypto.getRandomValues(new Uint8Array(6));
    p.newRoomId=Array.from(bytes,b=>ALPHABET[b%ALPHABET.length]).join('');
    p.newGameId=crypto.randomUUID();
    p.tokenHash=await hash(p.sessionToken); delete p.sessionToken;
    p.rateKey=await hash((context.ip || 'local')+':'+Math.floor(Date.now()/60000));
    const db=database();
    const [row]=await db.sql`SELECT mc_control(${action},${JSON.stringify(p)}::jsonb) AS result`;
    const { code, ...result }=row.result;
    if(result.gameId) result.iceServers=await iceServers(p.playerId);
    return json(result,code || 200);
  } catch { return json({ error: 'Multiplayer is temporarily unavailable. Please try again.' },503); }
}
export default (request,context)=>handle(request,context);
