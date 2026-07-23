# Deploying Micro Chess

Over-the-Board and Stockfish modes are 100% client-side and need **no backend**.
**Online multiplayer** is the only feature that needs a backend. If you see
**"Edge Function returned a non-2xx status code"**, it means the Supabase backend
below has not been deployed yet (the tables / RPCs / Edge Function are missing).

The Supabase project is `ncsqidwsimmdbkoiidlz` (see `js/supabase_client.js`).

---

## 1. Deploy the database schema (required)

This creates the `games`, `moves`, and `matchmaking_queue` tables plus the RPCs
the Edge Function calls. There are three migration files, applied in order —
`supabase/migrations/` is sorted by filename/timestamp automatically.

### Option A — Supabase Dashboard (no CLI)
1. Open the project → **SQL Editor** → **New query**.
2. Paste the entire contents of
   `supabase/migrations/20260718000000_multiplayer.sql`, then **Run**.
3. New query again, paste
   `supabase/migrations/20260723150000_join_by_game_id.sql`, then **Run**.
   (Adds `join_multiplayer_game_by_id`, used when a second player opens a
   shared invite link instead of typing the room code.)
4. New query again, paste
   `supabase/migrations/20260723160000_fix_matchmaking_status.sql`, then **Run**.
   (Fixes "Find a Match" sometimes surfacing a stale private room or old game
   instead of the freshly matched opponent.)

### Option B — Supabase CLI
```bash
supabase login
supabase link --project-ref ncsqidwsimmdbkoiidlz
supabase db push
```

---

## 2. Deploy the multiplayer Edge Function (required)

### Option A — Supabase CLI (recommended)
```bash
supabase functions deploy multiplayer --project-ref ncsqidwsimmdbkoiidlz
```
`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected into Edge Functions
automatically — you do **not** need to set them manually.

### Option B — Supabase Dashboard
1. Project → **Edge Functions** → **Deploy a new function** → name it `multiplayer`.
2. Paste the contents of `supabase/functions/multiplayer/index.ts`.
3. Deploy.

Or run the helper (does both steps 1 and 2 via the CLI):
```bash
bash scripts/deploy-supabase.sh
```

---

## 3. (Optional) Enable Realtime for instant updates

The client works with 5-second polling out of the box, so this is optional.
For instant move delivery, enable **Realtime → Broadcast** on the project
(on by default for new projects). If Realtime is unavailable the client silently
falls back to polling — multiplayer still works.

---

## 4. Deploy the frontend

The site is static. Build the bundles and deploy the repo root to any static
host (Netlify, etc.):
```bash
npm install
npm run build        # regenerates public/bundle.js and public/bundle-kindle.js
```
Then publish the repo root. `_redirects` is already set up for Netlify.

> After deploying a new frontend, users may keep a cached old page until the
> service worker updates. The SW cache version (`sw.js`, `CACHE_NAME`) is bumped
> on each release specifically so a redeploy evicts the old cache.

---

## Verify multiplayer end-to-end
1. Open `/online.html` in two different browsers (or one normal + one private
   window — they need distinct `localStorage`, i.e. distinct guest identities).
2. In the first, click **CREATE PRIVATE ROOM** and copy the 6-character code.
3. In the second, enter the code and click **JOIN ROOM**.
4. The game should go **active**; moves, clocks, draw offers, resign, and
   checkmate all sync between the two. **FIND A MATCH** on both pairs them via
   matchmaking.

If a step errors, the message now shows the **real** reason (e.g. a missing-table
error means step 1 was skipped).
