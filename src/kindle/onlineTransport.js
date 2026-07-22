// Kindle-specific multiplayer transport: calls the Edge Function directly via
// fetch instead of loading the Supabase JS SDK from its CDN. Elsewhere in this
// codebase the SDK is already treated as unverified on old Kindle WebKit (see
// KindleStockfishApp's 'supabase' engine option, which is opt-in rather than
// the default) — direct fetch reuses the same already-proven Kindle network
// path (fetch/XHR, polyfilled in polyfills.js) as everything else here.
// No Realtime subscription; the Kindle app polls get_game on an interval instead.
const SUPABASE_URL = 'https://ncsqidwsimmdbkoiidlz.supabase.co';
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5jc3FpZHdzaW1tZGJrb2lpZGx6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ1NTM5MDEsImV4cCI6MjEwMDEyOTkwMX0.PB5aBxvZ2bqNLxGrehobWj48xZ1AzWBRPUjsO1-M7Ec';
const FUNCTION_URL = SUPABASE_URL + '/functions/v1/multiplayer';
const ID_KEY = 'micro-chess-guest-id';
const SECRET_KEY = 'micro-chess-guest-secret';

function randomValue() {
  return Date.now() + '-' + Math.random().toString(36).slice(2) + '-' + Math.random().toString(36).slice(2);
}

// Same localStorage keys as the desktop client (src/multiplayer/client.js) so
// a guest's identity carries over whether they load the desktop or Kindle page.
export function guestIdentity() {
  var id = localStorage.getItem(ID_KEY);
  var secret = localStorage.getItem(SECRET_KEY);
  if (!id) {
    id = randomValue();
    localStorage.setItem(ID_KEY, id);
  }
  if (!secret) {
    secret = randomValue() + '-' + randomValue();
    localStorage.setItem(SECRET_KEY, secret);
  }
  return { guestId: id, guestSecret: secret };
}

export function multiplayer(action, payload) {
  var identity = guestIdentity();
  var body = Object.assign({ action: action, guestId: identity.guestId, guestSecret: identity.guestSecret }, payload || {});
  return fetch(FUNCTION_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + SUPABASE_ANON_KEY,
      apikey: SUPABASE_ANON_KEY,
    },
    body: JSON.stringify(body),
  })
    .then(function (res) {
      return res.json();
    })
    .then(function (data) {
      if (data && data.error) throw new Error(data.error);
      return data;
    });
}
