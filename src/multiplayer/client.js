export function newIdentity() {
  return { playerId: crypto.randomUUID(), instanceId: crypto.randomUUID(),
    sessionToken: Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2,'0')).join('') };
}
export async function control(action, session, payload = {}, signal) {
  const get = ['status','signals','matchmaking/status','reconnect/status'].includes(action);
  const credentials = { playerId: session.playerId, instanceId: session.instanceId, sessionToken: session.sessionToken,
    roomId: session.roomId, gameId: session.gameId, generation: session.generation };
  const body = { ...credentials, ...payload };
  const timeout = new AbortController();
  const abort = () => timeout.abort();
  signal?.addEventListener('abort',abort,{ once:true });
  if (signal?.aborted) abort();
  const timer = setTimeout(abort,15000);
  try {
    const response = await fetch('/api/multiplayer/'+action, {
      method: get ? 'GET':'POST', cache:'no-store', signal:timeout.signal,
      headers:get ? { 'X-Microchess-Session':JSON.stringify(body) } : { 'Content-Type':'application/json' },
      ...(get ? {} : { body:JSON.stringify(body) }),
    });
    const data=await response.json();
    if (!response.ok) { const error=new Error(data.error || 'Connection failed'); error.status=response.status; throw error; }
    return data;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort',abort); }
}
