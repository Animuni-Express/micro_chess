export const PROTOCOL = 1;
export const TIMING = Object.freeze({
  poll: 1000, signaling: 45000, grace: 4000, reconnect: 90000,
  heartbeat: 10000, health: 35000, inactivity: 300000, presence: 30000, ack: 15000,
});
export const LIMITS = Object.freeze({ moves: 4096, body: 524288, signal: 16384 });
