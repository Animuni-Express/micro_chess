const transitions = {
  idle:['creating-room','joining','matchmaking','reconnecting','error'],
  'creating-room':['waiting','signaling','error'], joining:['signaling','error'],
  waiting:['signaling','finishing','error'], matchmaking:['signaling','idle','error'],
  signaling:['connecting','reconnecting','error'], connecting:['handshaking','resume-handshake','connection-grace','reconnecting','error'],
  handshaking:['active','desynced','connection-grace','reconnecting','error'],
  active:['connection-grace','reconnecting','desynced','finishing','error'],
  'connection-grace':['active','reconnecting','error'], reconnecting:['signaling','finishing','error'],
  'resume-handshake':['active','desynced','connection-grace','reconnecting','error'],
  desynced:['finishing','error'], finishing:['finished','error'], finished:['idle'], error:['idle','reconnecting','finishing'],
};
export function transition(current,next) {
  if (current===next) return next;
  if (!transitions[current]?.includes(next)) throw new Error('Invalid multiplayer state transition: '+current+' → '+next);
  return next;
}
