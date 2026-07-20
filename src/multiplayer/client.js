const SUPABASE_CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
const SUPABASE_CONFIG = 'js/supabase_client.js';
const ID_KEY = 'micro-chess-guest-id';
const SECRET_KEY = 'micro-chess-guest-secret';

function randomValue() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function loadScript(source) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-micro-chess-src="${source}"]`);
    if (existing) {
      existing.addEventListener('load', resolve, { once: true });
      existing.addEventListener('error', reject, { once: true });
      if (existing.dataset.loaded === 'true') resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = source;
    script.async = true;
    script.dataset.microChessSrc = source;
    script.onload = () => {
      script.dataset.loaded = 'true';
      resolve();
    };
    script.onerror = () => reject(new Error(`Unable to load ${source}`));
    document.head.appendChild(script);
  });
}

export function guestIdentity() {
  let id = localStorage.getItem(ID_KEY);
  let secret = localStorage.getItem(SECRET_KEY);
  if (!id) {
    id = randomValue();
    localStorage.setItem(ID_KEY, id);
  }
  if (!secret) {
    secret = `${randomValue()}-${randomValue()}`;
    localStorage.setItem(SECRET_KEY, secret);
  }
  return { guestId: id, guestSecret: secret };
}

export async function getSupabaseClient() {
  if (!globalThis.supabase) await loadScript(SUPABASE_CDN);
  if (!globalThis.getSupabase) await loadScript(SUPABASE_CONFIG);
  const client = globalThis.getSupabase?.();
  if (!client) throw new Error('Multiplayer is not configured. Please try again later.');
  return client;
}

export async function multiplayer(action, payload = {}) {
  const client = await getSupabaseClient();
  const { data, error } = await client.functions.invoke('multiplayer', {
    body: { action, ...guestIdentity(), ...payload },
  });
  if (error) throw new Error(error.message || 'Multiplayer request failed');
  if (data?.error) throw new Error(data.error);
  return data;
}

export async function subscribeToGame(gameId, onUpdate) {
  const client = await getSupabaseClient();
  const channel = client
    .channel(`micro-chess-game:${gameId}`)
    .on('broadcast', { event: 'game_update' }, ({ payload }) => onUpdate(payload))
    .subscribe();

  return () => client.removeChannel(channel);
}
