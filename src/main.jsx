import { render } from 'preact';
import { OTBApp } from './components/OTBApp';
import { StockfishApp } from './components/StockfishApp';
import { OnlineGameApp } from './components/OnlineGameApp';

const mount = document.getElementById('app');
if (mount) {
  const path = window.location.pathname;
  const isStockfish = path.includes('stockfish');
  const isOnline = path.includes('online');
  render(isOnline ? <OnlineGameApp /> : isStockfish ? <StockfishApp /> : <OTBApp />, mount);
}

// Skip on localhost — a stuck/updating SW during active development causes
// spurious net::ERR_FAILED on navigation that has nothing to do with the app.
const isLocalDev = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname);
if ('serviceWorker' in navigator && window.location.protocol.startsWith('http') && !isLocalDev) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
