import { PROTOCOL } from './config.js';

export const TYPE = Object.freeze({ MOVE: 1, MOVE_ACK: 2, PING: 3, PONG: 4,
  RESIGN: 5, DRAW_OFFER: 6, DRAW_ACCEPT: 7, DRAW_DECLINE: 8,
  ACTIVITY_PROBE: 9, ACTIVITY_ACK: 10, GAME_OVER: 11, GAME_OVER_ACK: 12 });
export const RESULTS = ['draw', 'white_won', 'black_won'];
const PROMOTIONS = ['', 'q', 'r', 'b', 'n'];
export function squareIndex(square) {
  if (!/^[a-h][1-8]$/.test(square)) throw new Error('Invalid square');
  return square.charCodeAt(0) - 97 + (Number(square[1]) - 1) * 8;
}
export function squareName(index) {
  if (!Number.isInteger(index) || index < 0 || index > 63) throw new Error('Invalid square');
  return String.fromCharCode(97 + index % 8) + (Math.floor(index / 8) + 1);
}
export function encode(type, seq, { uci, digest, result } = {}) {
  const size = type === TYPE.MOVE ? 25 : type === TYPE.MOVE_ACK ? 22 : type >= TYPE.GAME_OVER ? 7 : 6;
  if (!Object.values(TYPE).includes(type) || !Number.isInteger(seq) || seq < 0 || seq > 0xffffffff) throw new Error('Invalid packet');
  const data = new ArrayBuffer(size), view = new DataView(data);
  view.setUint8(0, PROTOCOL); view.setUint8(1, type); view.setUint32(2, seq); // network byte order
  if (type === TYPE.MOVE) {
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) throw new Error('Invalid move');
    view.setUint8(6, squareIndex(uci.slice(0, 2))); view.setUint8(7, squareIndex(uci.slice(2, 4)));
    view.setUint8(8, PROMOTIONS.indexOf(uci[4] || ''));
  }
  if (type === TYPE.MOVE || type === TYPE.MOVE_ACK) {
    if (!/^[0-9a-f]{32}$/.test(digest)) throw new Error('Invalid digest');
    const offset = type === TYPE.MOVE ? 9 : 6;
    for (let i = 0; i < 16; i++) view.setUint8(offset + i, parseInt(digest.slice(i * 2, i * 2 + 2), 16));
  }
  if (type >= TYPE.GAME_OVER) {
    if (!RESULTS.includes(result)) throw new Error('Invalid result');
    view.setUint8(6, RESULTS.indexOf(result));
  }
  return data;
}
export function decode(data) {
  if (!(data instanceof ArrayBuffer) || data.byteLength < 6 || data.byteLength > 25) throw new Error('Invalid packet length');
  const view = new DataView(data), type = view.getUint8(1), seq = view.getUint32(2);
  if (view.getUint8(0) !== PROTOCOL || !Object.values(TYPE).includes(type)) throw new Error('Unsupported packet');
  const size = type === TYPE.MOVE ? 25 : type === TYPE.MOVE_ACK ? 22 : type >= TYPE.GAME_OVER ? 7 : 6;
  if (data.byteLength !== size) throw new Error('Invalid packet length');
  const packet = { type, seq };
  if (type === TYPE.MOVE) {
    const promotion = view.getUint8(8);
    if (promotion > 4) throw new Error('Invalid promotion');
    packet.uci = squareName(view.getUint8(6)) + squareName(view.getUint8(7)) + PROMOTIONS[promotion];
  }
  if (type === TYPE.MOVE || type === TYPE.MOVE_ACK) {
    const offset = type === TYPE.MOVE ? 9 : 6;
    packet.digest = Array.from(new Uint8Array(data, offset, 16), b => b.toString(16).padStart(2, '0')).join('');
  }
  if (type >= TYPE.GAME_OVER) {
    packet.result = RESULTS[view.getUint8(6)];
    if (!packet.result) throw new Error('Invalid result');
  }
  return packet;
}
