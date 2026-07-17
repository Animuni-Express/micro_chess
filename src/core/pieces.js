// Piece images are served same-origin (public/pieces/) so the service worker
// can cache them — avoids 12 slow cross-origin Wikimedia fetches per load.
export const PIECE_ICONS = {
  wp: 'pieces/wp.svg',
  wn: 'pieces/wn.svg',
  wb: 'pieces/wb.svg',
  wr: 'pieces/wr.svg',
  wq: 'pieces/wq.svg',
  wk: 'pieces/wk.svg',
  bp: 'pieces/bp.svg',
  bn: 'pieces/bn.svg',
  bb: 'pieces/bb.svg',
  br: 'pieces/br.svg',
  bq: 'pieces/bq.svg',
  bk: 'pieces/bk.svg',
};

export function pieceIcon(color, type) {
  return PIECE_ICONS[color + type] || '';
}
