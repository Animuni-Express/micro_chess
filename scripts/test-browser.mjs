import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const base=process.env.MICRO_CHESS_TEST_URL || 'http://localhost:8888';
const channel=process.env.MICRO_CHESS_BROWSER_CHANNEL || (existsSync(chromium.executablePath())?undefined:existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe')?'chrome':'msedge');
const browser=await chromium.launch({headless:true,channel});
const contexts=[];
const errors=[];
async function player(path='/online.html',init) {
  const context=await browser.newContext(); contexts.push(context);
  if(init) await context.addInitScript(init);
  const page=await context.newPage();
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base+path);
  return page;
}
async function state(page) { return page.evaluate(()=>JSON.parse(window.render_game_to_text())); }
async function wait(page,wanted) {
  await page.waitForFunction(wanted=>window.render_game_to_text && JSON.parse(window.render_game_to_text()).state===wanted,wanted,{timeout:60000});
}
async function move(page,from,to) {
  await page.locator(`[data-square="${from}"]`).click();await page.locator(`[data-square="${to}"]`).click();
}
try {
  const a=await player(),b=await player();
  await a.getByRole('button',{name:'CREATE PRIVATE ROOM'}).click();await wait(a,'waiting');
  const code=(await state(a)).roomId;
  await b.getByRole('textbox',{name:'Room code'}).fill(code);await b.getByRole('button',{name:'JOIN ROOM',exact:true}).click();
  await Promise.all([wait(a,'active'),wait(b,'active')]);
  assert.equal(await a.locator('.clock').count(),0);
  const traffic=[];
  const observe=request=>{if(request.url().includes('/api/multiplayer/'))traffic.push(request.url());};
  a.on('request',observe);b.on('request',observe);
  for(const [page,from,to,seq] of [[a,'e2','e4',1],[b,'e7','e5',2],[a,'g1','f3',3],[b,'b8','c6',4]]) {
    await move(page,from,to);
    await Promise.all([a,b].map(p=>p.waitForFunction(seq=>JSON.parse(window.render_game_to_text()).sequence===seq,seq)));
  }
  assert.equal((await state(a)).fen,(await state(b)).fen);
  await new Promise(resolve=>setTimeout(resolve,11000));
  assert.deepEqual(traffic,[],'active moves and P2P heartbeats must cause zero HTTP requests');
  console.log('PASS private create/join, WebRTC handshake, binary moves, digest/SAN and zero gameplay HTTP');
  a.off('request',observe);b.off('request',observe);
  await a.reload();await Promise.all([wait(a,'active'),wait(b,'active')]);
  assert.equal((await state(a)).sequence,4);assert.equal((await state(a)).fen,(await state(b)).fen);
  console.log('PASS refresh, checkpoint, fresh WebRTC reconnect and history restoration');
  await a.getByRole('button',{name:'RESIGN',exact:true}).click();await Promise.all([wait(a,'finished'),wait(b,'finished')]);
  assert.equal((await state(b)).result,'black_won');
  for(const page of [a,b]) assert.equal(await page.evaluate(()=>new Promise((resolve,reject)=>{const r=indexedDB.open('micro-chess-temporary',1);r.onsuccess=()=>{const db=r.result,q=db.transaction('sessions').objectStore('sessions').get('active');q.onsuccess=()=>{resolve(q.result===undefined);db.close();};q.onerror=reject;};r.onerror=reject;})),true);
  console.log('PASS resignation, terminal handshake and local cleanup');
  const c=await player(),d=await player();
  await c.getByRole('button',{name:'FIND A MATCH'}).click();await wait(c,'matchmaking');
  await d.getByRole('button',{name:'FIND A MATCH'}).click();await Promise.all([wait(c,'active'),wait(d,'active')]);
  assert.equal((await state(c)).roomId,(await state(d)).roomId);
  await c.getByRole('button',{name:'OFFER DRAW'}).click();await d.getByRole('button',{name:'ACCEPT DRAW'}).click();
  await Promise.all([wait(c,'finished'),wait(d,'finished')]);assert.equal((await state(c)).result,'draw');
  console.log('PASS public matchmaking, draw offer/accept and terminal cleanup');
  const kindlePlayer=await player('/online_kindle.html'), desktopPeer=await player();
  await kindlePlayer.getByRole('button',{name:'CREATE PRIVATE ROOM'}).click();
  await kindlePlayer.locator('.container strong').waitFor();
  const kindleCode=await kindlePlayer.locator('.container strong').innerText();
  await desktopPeer.getByRole('textbox',{name:'Room code'}).fill(kindleCode);
  await desktopPeer.getByRole('button',{name:'JOIN ROOM',exact:true}).click();
  await wait(desktopPeer,'active');await kindlePlayer.locator('#status').filter({hasText:'Your move'}).waitFor();
  await move(kindlePlayer,'e2','e4');
  await desktopPeer.waitForFunction(()=>JSON.parse(window.render_game_to_text()).sequence===1);
  await move(desktopPeer,'e7','e5');
  await kindlePlayer.locator('#status').filter({hasText:'Your move'}).waitFor();
  await mkdir('output',{recursive:true});await kindlePlayer.screenshot({path:'output/kindle-online-active.png',fullPage:true});
  await kindlePlayer.getByRole('button',{name:'RESIGN',exact:true}).click();await wait(desktopPeer,'finished');
  await kindlePlayer.getByText('Black wins.',{exact:true}).waitFor();
  console.log('PASS dedicated Kindle ES5 UI creates room, exchanges moves with desktop and resigns');
  const white=await player(),black=await player();
  await white.getByRole('button',{name:'FIND A MATCH'}).click();await wait(white,'matchmaking');
  await black.getByRole('button',{name:'FIND A MATCH'}).click();await Promise.all([wait(white,'active'),wait(black,'active')]);
  for(const [page,from,to,seq] of [[white,'f2','f3',1],[black,'e7','e5',2],[white,'g2','g4',3],[black,'d8','h4',4]]) {
    await move(page,from,to);
    if(seq<4) await Promise.all([white,black].map(p=>p.waitForFunction(seq=>JSON.parse(window.render_game_to_text()).sequence===seq,seq)));
  }
  await Promise.all([wait(white,'finished'),wait(black,'finished')]);assert.equal((await state(white)).result,'black_won');
  console.log('PASS checkmate is independently validated and finalized by both peers');
  const kindle=await player('/online_kindle.html',()=>{window.RTCPeerConnection=undefined;});
  await kindle.getByText('This browser cannot make the secure peer connection needed for online play.',{exact:false}).waitFor();
  await mkdir('output',{recursive:true});await kindle.screenshot({path:'output/kindle-online.png',fullPage:true});
  const stockfish=await player('/stockfish_kindle.html');await stockfish.getByText('AI ENGINE:').waitFor();
  assert.deepEqual(await stockfish.locator('select').last().locator('option').evaluateAll(options=>options.map(option=>option.value)),['chessapi','lichess','local']);
  await stockfish.screenshot({path:'output/kindle-stockfish.png',fullPage:true});
  const otb=await player('/over_the_board_kindle.html');
  const start=otb.getByRole('button',{name:'START GAME'});if(await start.count()) await start.click();
  await move(otb,'e2','e4');assert.equal(await otb.locator('[data-square="e4"] img').count(),1);
  console.log('PASS Kindle dedicated compatibility UI, Stockfish setup and local board');
  assert.deepEqual(errors,[],'no uncaught page errors');
} finally {for(const context of contexts) await context.close();await browser.close();}
