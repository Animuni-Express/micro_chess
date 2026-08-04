// Supabase Edge Function: lichess
//
// Brokers anonymous Micro Chess guests into real games against real Lichess
// players. The Lichess personal access token(s) live only in this function's
// secrets (LICHESS_TOKENS — see .env.example / DEPLOY.md); they are never sent to
// the browser, and the browser never needs a Lichess account.
//
// The interesting logic is in relay.js / lichess_api.js (both plain JS so they
// are unit-testable outside Deno). This file is wiring only.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { createLichessApi, LichessError } from './lichess_api.js';
import { createStore } from './store.js';
import { createRelay, readTokens, resolveConfig, RelayError } from './relay.js';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

const env = {
  LICHESS_TOKENS: Deno.env.get('LICHESS_TOKENS'),
  LICHESS_API_TOKEN: Deno.env.get('LICHESS_API_TOKEN'),
  LICHESS_TOKEN: Deno.env.get('LICHESS_TOKEN'),
  LICHESS_SEEK_INCREMENT: Deno.env.get('LICHESS_SEEK_INCREMENT'),
  LICHESS_SEEK_HOLD_MS: Deno.env.get('LICHESS_SEEK_HOLD_MS'),
  LICHESS_STREAM_HOLD_MS: Deno.env.get('LICHESS_STREAM_HOLD_MS'),
  LICHESS_SEAT_LEASE_MINUTES: Deno.env.get('LICHESS_SEAT_LEASE_MINUTES'),
};

const tokens = readTokens(env);
const config = resolveConfig(env);

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const body = await request.json();
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRole = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceRole) throw new RelayError('Lichess relay is not configured', 503);

    const admin = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false } });
    const relay = createRelay({
      api: createLichessApi({ fetch: globalThis.fetch }),
      store: createStore(admin),
      tokens,
      config,
    });

    return respond(await relay.handle(body));
  } catch (error) {
    const status = error instanceof RelayError || error instanceof LichessError ? error.status : 400;
    const message = error instanceof Error ? error.message : 'Lichess relay request failed';
    console.error(`lichess relay error (${status}): ${message}`);
    return respond({ error: message }, status >= 400 && status <= 599 ? status : 400);
  }
});
