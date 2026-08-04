import { createLichessApi } from '../supabase/functions/lichess/lichess_api';
import { createRelay, readTokens, resolveConfig, uciFromMove } from '../supabase/functions/lichess/relay';
import { FakeLichess } from './helpers/fakeLichess';
import { createMemoryStore } from './helpers/memoryStore';

const GUEST_A = { guestId: 'guest-aaaaaaaaaaaaaaaa', guestSecret: 'secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaa' };
const GUEST_B = { guestId: 'guest-bbbbbbbbbbbbbbbb', guestSecret: 'secret-bbbbbbbbbbbbbbbbbbbbbbbbbbbb' };

function setup({ tokens = ['lip_token_one'], lichessOptions = {}, config = {} } = {}) {
  const lichess = new FakeLichess(lichessOptions);
  const store = createMemoryStore();
  const relay = createRelay({
    api: createLichessApi({ fetch: lichess.fetch, baseUrl: 'https://lichess.test' }),
    store,
    tokens,
    config: { seekHoldMs: 800, streamHoldMs: 800, seatLeaseSeconds: 600, ...config },
    logger: { error: () => {} },
  });
  return { lichess, store, relay };
}

describe('token configuration', () => {
  test('reads a comma-separated list and de-duplicates', () => {
    expect(readTokens({ LICHESS_TOKENS: 'lip_a, lip_b ,lip_a' })).toEqual(['lip_a', 'lip_b']);
  });

  test('falls back to the single-token aliases', () => {
    expect(readTokens({ LICHESS_API_TOKEN: 'lip_solo' })).toEqual(['lip_solo']);
    expect(readTokens({ LICHESS_TOKEN: 'lip_solo' })).toEqual(['lip_solo']);
    expect(readTokens({})).toEqual([]);
  });

  test('clamps tuning knobs to sane bounds', () => {
    expect(resolveConfig({ LICHESS_SEEK_HOLD_MS: '999999' }).seekHoldMs).toBe(55000);
    expect(resolveConfig({ LICHESS_SEEK_HOLD_MS: 'nonsense' }).seekHoldMs).toBe(20000);
    expect(resolveConfig({ LICHESS_SEAT_LEASE_MINUTES: '5' }).seatLeaseSeconds).toBe(300);
  });
});

describe('move encoding', () => {
  test('builds UCI and rejects nonsense', () => {
    expect(uciFromMove('e2', 'e4')).toBe('e2e4');
    expect(uciFromMove('E7', 'E8', 'Q')).toBe('e7e8q');
    expect(() => uciFromMove('e2', 'z9')).toThrow(/Invalid move/);
    expect(() => uciFromMove('e7', 'e8', 'k')).toThrow(/promotion/);
  });
});

describe('status', () => {
  test('reports the relay account and its scopes', async () => {
    const { relay } = setup();
    const status = await relay.handle({ action: 'status' });
    expect(status.configured).toBe(true);
    expect(status.seatCount).toBe(1);
    expect(status.freeSeats).toBe(1);
    expect(status.rated).toBe(false);
    expect(status.accounts[0]).toMatchObject({ seatId: 'slot-0', username: 'MicroChessRelay', error: null });
    expect(status.accounts[0].scopes).toContain('board:play');
  });

  test('does not re-verify a token Lichess already confirmed', async () => {
    const { relay, lichess } = setup();
    await relay.handle({ action: 'status' });
    await relay.handle({ action: 'status' });
    const probes = lichess.calls.filter((call) => call.pathname === '/api/token/test').length;
    expect(probes).toBe(1);

    // …unless asked to, so a rotated or revoked token can be re-checked on demand.
    await relay.handle({ action: 'status', probe: true });
    expect(lichess.calls.filter((call) => call.pathname === '/api/token/test').length).toBe(2);
  });

  test('flags a token that lacks board:play', async () => {
    const { relay } = setup({ lichessOptions: { scopes: 'preference:read' } });
    const status = await relay.handle({ action: 'status' });
    expect(status.accounts[0].error).toMatch(/board:play/);
  });

  test('flags a token Lichess does not recognise', async () => {
    const { relay } = setup({ lichessOptions: { tokenKnown: false } });
    const status = await relay.handle({ action: 'status' });
    expect(status.accounts[0].error).toMatch(/does not recognise/i);
  });

  test('reports unconfigured when no token is set', async () => {
    const { relay } = setup({ tokens: [] });
    const status = await relay.handle({ action: 'status' });
    expect(status.configured).toBe(false);
    await expect(relay.handle({ action: 'find_opponent', timeControl: 300, ...GUEST_A })).rejects.toThrow(
      /not configured/,
    );
  });
});

describe('finding a Lichess opponent', () => {
  test('posts a casual seek and pairs the guest with the player who accepts it', async () => {
    const { relay, lichess, store } = setup();
    lichess.onSeek = () => lichess.startGame({ gameId: 'abcd1234', relayColor: 'w' });

    const response = await relay.handle({ action: 'find_opponent', timeControl: 300, ...GUEST_A });

    expect(lichess.lastSeek).toMatchObject({ rated: 'false', time: '5', increment: '0', variant: 'standard' });
    expect(response.game).toMatchObject({
      gameId: 'abcd1234',
      color: 'w',
      rated: false,
      finished: false,
      moveCount: 0,
      lichessUrl: 'https://lichess.org/abcd1234',
    });
    expect(response.game.opponent).toMatchObject({ name: 'RandomPlayer', rating: 1543 });
    // The guest never learns anything about the relay account's credentials.
    expect(JSON.stringify(response)).not.toContain('lip_token_one');
    expect(store.seatsMap.get('slot-0')).toMatchObject({ status: 'playing', game_id: 'abcd1234' });
  });

  test('detects which side the relay account was given', async () => {
    const { relay, lichess } = setup();
    lichess.onSeek = () => lichess.startGame({ gameId: 'blackgame', relayColor: 'b' });
    const response = await relay.handle({ action: 'find_opponent', timeControl: 600, ...GUEST_A });
    expect(response.game.color).toBe('b');
    expect(lichess.lastSeek.time).toBe('10');
  });

  test('reports "searching" when nobody accepts, without leaking the seat', async () => {
    const { relay, store } = setup();
    const response = await relay.handle({ action: 'find_opponent', timeControl: 300, ...GUEST_A });
    expect(response).toMatchObject({ searching: true, relayAccount: 'MicroChessRelay' });
    expect(store.seatsMap.get('slot-0').status).toBe('seeking');

    // Cancelling hands the seat straight back.
    await relay.handle({ action: 'cancel_search', ...GUEST_A });
    expect(store.seatsMap.get('slot-0')).toMatchObject({ status: 'idle', guest_id: null });
  });

  test('tells the second guest the single relay seat is busy', async () => {
    const { relay, lichess } = setup();
    lichess.onSeek = () => lichess.startGame({ gameId: 'abcd1234' });
    await relay.handle({ action: 'find_opponent', timeControl: 300, ...GUEST_A });

    const busy = await relay.handle({ action: 'find_opponent', timeControl: 300, ...GUEST_B });
    expect(busy).toMatchObject({ busy: true, seats: 1 });
    expect(busy.message).toMatch(/in use/i);
  });

  test('two tokens serve two guests at once', async () => {
    const { relay, lichess } = setup({ tokens: ['lip_one', 'lip_two'] });
    lichess.onSeek = () => lichess.startGame({ gameId: `game${lichess.seeks}` });

    const first = await relay.handle({ action: 'find_opponent', timeControl: 300, ...GUEST_A });
    const second = await relay.handle({ action: 'find_opponent', timeControl: 300, ...GUEST_B });
    expect(first.game.gameId).toBe('game1');
    expect(second.game.gameId).toBe('game2');
  });

  test('never relays a rated game onto the shared account', async () => {
    const { relay, lichess } = setup();
    // A rated game already in progress on the relay account is replayed by the
    // event stream and listed by /api/account/playing. Handing a guest control of
    // it would mean strangers moving in a rated game — so it must be ignored.
    lichess.startGame({ gameId: 'ratedgame', rated: true });
    const response = await relay.handle({ action: 'find_opponent', timeControl: 300, ...GUEST_A });
    expect(response.searching).toBe(true);
    expect(response.game).toBeUndefined();
  });

  test('adopts an orphaned game instead of seeking twice on one account', async () => {
    const { relay, lichess } = setup();
    // Models a seek accepted just after the previous call gave up: the account is
    // already in a game that no guest owns.
    lichess.startGame({ gameId: 'orphan01' });
    const response = await relay.handle({ action: 'find_opponent', timeControl: 300, ...GUEST_A });
    expect(response.game.gameId).toBe('orphan01');
    expect(lichess.seeks).toBe(0);
  });

  test('resumes the guest\'s game in progress rather than starting another', async () => {
    const { relay, lichess } = setup();
    lichess.onSeek = () => lichess.startGame({ gameId: 'abcd1234' });
    await relay.handle({ action: 'find_opponent', timeControl: 300, ...GUEST_A });

    const again = await relay.handle({ action: 'find_opponent', timeControl: 300, ...GUEST_A });
    expect(again).toMatchObject({ resumed: true });
    expect(again.game.gameId).toBe('abcd1234');
    expect(lichess.seeks).toBe(1);
  });
});

describe('playing a relayed game', () => {
  async function startedGame(options) {
    const context = setup(options);
    context.lichess.onSeek = () => context.lichess.startGame({ gameId: 'abcd1234', relayColor: 'w' });
    const response = await context.relay.handle({ action: 'find_opponent', timeControl: 300, ...GUEST_A });
    return { ...context, game: response.game };
  }

  test('forwards a move to Lichess and returns the updated position', async () => {
    const { relay, lichess } = await startedGame();
    const response = await relay.handle({
      action: 'submit_move',
      gameId: 'abcd1234',
      from: 'e2',
      to: 'e4',
      ...GUEST_A,
    });
    expect(lichess.calls.some((call) => call.pathname === '/api/board/game/abcd1234/move/e2e4')).toBe(true);
    expect(response.game).toMatchObject({ moves: 'e2e4', moveCount: 1, finished: false });
  });

  test('forwards a promotion as UCI', async () => {
    const { relay, lichess } = await startedGame();
    lichess.games.get('abcd1234').state.moves = 'e2e4 d7d5 e4d5 c7c6 d5c6 b8d7 c6b7 d7f6';
    await relay.handle({ action: 'submit_move', gameId: 'abcd1234', from: 'b7', to: 'a8', promotion: 'q', ...GUEST_A });
    expect(lichess.calls.some((call) => call.pathname === '/api/board/game/abcd1234/move/b7a8q')).toBe(true);
  });

  test('long-polls until the Lichess opponent replies', async () => {
    const { relay, lichess } = await startedGame();
    await relay.handle({ action: 'submit_move', gameId: 'abcd1234', from: 'e2', to: 'e4', ...GUEST_A });

    const pending = relay.handle({ action: 'get_game', gameId: 'abcd1234', wait: true, sinceMoveCount: 1, ...GUEST_A });
    setTimeout(() => lichess.playMove('abcd1234', 'e7e5'), 25);
    const response = await pending;

    expect(response.game).toMatchObject({ moves: 'e2e4 e7e5', moveCount: 2 });
    expect(response.serverNow).toBeTruthy();
  });

  test('a non-waiting read returns the current position immediately', async () => {
    const { relay } = await startedGame();
    const response = await relay.handle({ action: 'get_game', gameId: 'abcd1234', ...GUEST_A });
    expect(response.game).toMatchObject({ moveCount: 0, finished: false });
  });

  test('surfaces a Lichess move rejection as an error', async () => {
    const { relay, lichess } = await startedGame();
    lichess.failNext = { pathname: '/api/board/game/abcd1234/move/e2e5', status: 400, message: 'Not your turn' };
    await expect(
      relay.handle({ action: 'submit_move', gameId: 'abcd1234', from: 'e2', to: 'e5', ...GUEST_A }),
    ).rejects.toThrow(/Not your turn/);
  });

  test('relays draw offers and declines', async () => {
    const { relay, lichess } = await startedGame();
    await relay.handle({ action: 'offer_draw', gameId: 'abcd1234', ...GUEST_A });
    expect(lichess.calls.some((call) => call.pathname === '/api/board/game/abcd1234/draw/yes')).toBe(true);
    await relay.handle({ action: 'decline_draw', gameId: 'abcd1234', ...GUEST_A });
    expect(lichess.calls.some((call) => call.pathname === '/api/board/game/abcd1234/draw/no')).toBe(true);
  });

  test('resigning ends the game and returns the seat to the pool', async () => {
    const { relay, store } = await startedGame();
    const response = await relay.handle({ action: 'resign', gameId: 'abcd1234', ...GUEST_A });
    expect(response.game).toMatchObject({ finished: true, status: 'resign', winner: 'b' });
    expect(store.seatsMap.get('slot-0')).toMatchObject({ status: 'idle', guest_id: null });

    // Which frees the relay account for the next guest.
    const next = await relay.handle({ action: 'find_opponent', timeControl: 300, ...GUEST_B });
    expect(next.busy).toBeUndefined();
  });

  test('a checkmate from Lichess finishes the game', async () => {
    const { relay, lichess, store } = await startedGame();
    lichess.finish('abcd1234', 'mate', 'white');
    const response = await relay.handle({ action: 'get_game', gameId: 'abcd1234', ...GUEST_A });
    expect(response.game).toMatchObject({ finished: true, status: 'mate', winner: 'w' });
    expect(store.seatsMap.get('slot-0').status).toBe('idle');
  });

  test('another guest cannot read or move in someone else\'s relayed game', async () => {
    const { relay } = await startedGame();
    await expect(relay.handle({ action: 'get_game', gameId: 'abcd1234', ...GUEST_B })).rejects.toThrow(
      /access denied/i,
    );
    await expect(
      relay.handle({ action: 'submit_move', gameId: 'abcd1234', from: 'e2', to: 'e4', ...GUEST_B }),
    ).rejects.toThrow(/access denied/i);
  });

  test('rejects a malformed guest identity', async () => {
    const { relay } = setup();
    await expect(relay.handle({ action: 'find_opponent', timeControl: 300, guestId: 'x', guestSecret: 'y' })).rejects.toThrow(
      /Invalid guest identity/,
    );
  });

  test('rejects an unsupported time control and unknown actions', async () => {
    const { relay } = setup();
    await expect(relay.handle({ action: 'find_opponent', timeControl: 45, ...GUEST_A })).rejects.toThrow(
      /Unsupported time control/,
    );
    await expect(relay.handle({ action: 'teleport', ...GUEST_A })).rejects.toThrow(/Unknown Lichess relay action/);
  });

  test('active_game lets a returning browser pick the game back up', async () => {
    const { relay } = await startedGame();
    const response = await relay.handle({ action: 'active_game', ...GUEST_A });
    expect(response.game.gameId).toBe('abcd1234');
    const other = await relay.handle({ action: 'active_game', ...GUEST_B });
    expect(other.game).toBeNull();
  });

  test('a rate-limited read serves the cached position with a warning', async () => {
    const { relay, lichess, store } = await startedGame();
    lichess.failNext = {
      pathname: '/api/board/game/stream/abcd1234',
      status: 429,
      message: 'Too many requests',
      headers: { 'Retry-After': '30' },
    };
    const response = await relay.handle({ action: 'get_game', gameId: 'abcd1234', ...GUEST_A });
    expect(response.warning).toMatch(/rate-limit/i);
    expect(response.game.moveCount).toBe(0);
    expect(store.seatsMap.get('slot-0').cooldown_until).toBeTruthy();
  });
});

describe('abandoned games', () => {
  // Each seek pairs into a *new* game id, the way Lichess would.
  function pairFreshGames(lichess) {
    lichess.onSeek = () => lichess.startGame({ gameId: `game${lichess.seeks}` });
  }

  test('an expired lease resigns the game on Lichess and frees the seat', async () => {
    const { relay, lichess, store } = setup();
    pairFreshGames(lichess);
    await relay.handle({ action: 'find_opponent', timeControl: 300, ...GUEST_A });
    await relay.handle({ action: 'submit_move', gameId: 'game1', from: 'e2', to: 'e4', ...GUEST_A });
    lichess.playMove('game1', 'e7e5');

    // The guest closes the tab: the lease lapses.
    store.seatsMap.get('slot-0').lease_expires_at = new Date(Date.now() - 1000).toISOString();

    const next = await relay.handle({ action: 'find_opponent', timeControl: 300, ...GUEST_B });
    expect(lichess.calls.some((call) => call.pathname === '/api/board/game/game1/resign')).toBe(true);
    expect(lichess.games.get('game1').state.status).toBe('resign');
    expect(store.gamesMap.get('game1')).toMatchObject({ finished: true, status: 'resign' });
    // Seat handed to the next guest rather than left wedged.
    expect(next.busy).toBeUndefined();
    expect(next.game.gameId).toBe('game2');
  });

  test('a game abandoned before it started is aborted, not resigned', async () => {
    const { relay, lichess, store } = setup();
    pairFreshGames(lichess);
    await relay.handle({ action: 'find_opponent', timeControl: 300, ...GUEST_A });
    store.seatsMap.get('slot-0').lease_expires_at = new Date(Date.now() - 1000).toISOString();

    await relay.handle({ action: 'find_opponent', timeControl: 300, ...GUEST_B });
    expect(lichess.calls.some((call) => call.pathname === '/api/board/game/game1/abort')).toBe(true);
    expect(store.gamesMap.get('game1')).toMatchObject({ finished: true, status: 'aborted' });
  });

  test('a seat whose Lichess game cannot be cleaned up is not handed out', async () => {
    const { relay, lichess, store } = setup();
    lichess.onSeek = () => lichess.startGame({ gameId: 'abcd1234' });
    await relay.handle({ action: 'find_opponent', timeControl: 300, ...GUEST_A });
    store.seatsMap.get('slot-0').lease_expires_at = new Date(Date.now() - 1000).toISOString();
    lichess.failNext = { pathname: '/api/board/game/abcd1234/abort', status: 500, message: 'boom' };

    const response = await relay.handle({ action: 'find_opponent', timeControl: 300, ...GUEST_B });
    expect(response.busy).toBe(true);
    expect(store.seatsMap.get('slot-0').status).toBe('reaping');
  });
});
