// Polyfills MUST load before Preact: Preact captures `typeof Promise` at
// module-init time for its render scheduler.
import './polyfills';
import { render } from 'preact';
import { KindleOTBApp } from './KindleOTBApp';
import { KindleStockfishApp } from './KindleStockfishApp';

const mount = document.getElementById('app');
if (mount) {
  const isStockfish = window.location.pathname.includes('stockfish');
  render(isStockfish ? <KindleStockfishApp /> : <KindleOTBApp />, mount);
}

// Skip on localhost — a stuck/updating SW during active development causes
// spurious net::ERR_FAILED on navigation that has nothing to do with the app.
const isLocalDev = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname);
if ('serviceWorker' in navigator && window.location.protocol.startsWith('http') && !isLocalDev) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
