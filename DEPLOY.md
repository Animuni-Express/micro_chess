# Deploying Micro Chess

Over-the-Board and Stockfish modes are 100% client-side and need **no backend**.
**Online multiplayer** — both guest-vs-guest play and Lichess opponents (step 3) —
is the only feature that needs a backend. If you see
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
   `supabase/migrations/20260804120000_lichess_relay.sql`, then **Run**.
   (Adds `lichess_seats` / `lichess_games` and their RPCs, used by step 3.
   Skip only if you are not enabling Lichess opponents.)

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

## 3. Lichess opponents ("PLAY A LICHESS PLAYER")

This mode finds a **real opponent from the public lichess.org pool** for a Micro
Chess visitor who has no Lichess account. The `lichess` Edge Function holds a
Lichess token, posts a casual seek on that account, and relays moves between the
browser and Lichess. The player stays anonymous: they never log in, and Lichess
only ever sees the relay account.

### 3.1 Read this first — how the relay behaves, and its limits

- **One token = one seat = one game at a time.** A Lichess account can only be in
  one relayed game, so the number of tokens is the number of Micro Chess players
  who can be playing Lichess opponents simultaneously. With every seat taken, the
  lobby says so and the player can use ordinary Micro Chess matchmaking instead.
  Add more tokens (more accounts) to raise capacity.
- **Casual only, enforced in code.** The relay always seeks with `rated=false` and
  refuses to attach a guest to any rated game. Letting strangers move in rated
  games on a shared account would be rating manipulation.
- **Lichess ToS caveat — decide this deliberately.** Lichess's terms expect an
  account to be used by one person, and this design has many people playing
  through one account. That is the part of this feature most likely to draw a
  Lichess account restriction, so:
  - Use a **dedicated relay account**, never your personal one.
  - Say what it is in that account's Lichess profile bio (e.g. "Bridge account for
    micro-chess.pages.dev — casual games are relayed from anonymous web
    visitors"). Lichess moderators look at profiles, and being upfront is what
    keeps this from looking like account sharing or engine assistance.
  - The fully ToS-clean alternative is per-user OAuth (each visitor authorises
    their *own* Lichess account via PKCE). That needs a Lichess account per
    player, which is exactly what this feature exists to avoid — it is the right
    upgrade if the relay ever gets restricted.
- **Abandoned games are cleaned up.** If a player closes the tab, the seat's lease
  lapses and the relay aborts (before move 2) or resigns the Lichess game, so the
  opponent is not left waiting and the account is freed.

### 3.2 Create a token

1. Sign in as the **relay account** on lichess.org.
2. Open
   <https://lichess.org/account/oauth/token/create?scopes[]=board:play&description=Micro%20Chess%20relay>
   — the only scope needed is **`board:play`** ("Play games with the board API").
3. Copy the `lip_…` token. Lichess shows it once.

### 3.3 Put the token in `.env` (never in git)

```bash
cp .env.example .env
# edit .env:  LICHESS_TOKENS=lip_your_token_here
```

`.env` is gitignored — the token must never be committed, and it is never sent to
the browser. For more capacity, list several: `LICHESS_TOKENS=lip_a,lip_b,lip_c`.

Check the token before deploying anything:

```bash
bash scripts/check-lichess-token.sh
# == lip_abcd…wxyz
#    scopes: board:play
#    OK    relay account: YourRelayAccount (opponents will see this name)
#          ongoing games on this account: 0 (a relayed game needs the account free)
```

### 3.4 Deploy the function and push the secret

```bash
supabase db push                                             # adds the relay tables (step 1)
supabase functions deploy lichess --project-ref ncsqidwsimmdbkoiidlz
bash scripts/set-lichess-secrets.sh                          # pushes LICHESS_* from .env
```

`scripts/deploy-supabase.sh` now does all of this, including the secrets.

Secrets live only in Supabase; to rotate a token, edit `.env` and re-run
`scripts/set-lichess-secrets.sh` — the relay notices the fingerprint changed and
resets that seat.

Optional tuning secrets (all have sensible defaults) are documented in
`.env.example`: `LICHESS_SEEK_INCREMENT`, `LICHESS_SEEK_HOLD_MS`,
`LICHESS_STREAM_HOLD_MS`, `LICHESS_SEAT_LEASE_MINUTES`.

### 3.5 Verify it connects to a real player

1. Open `/online.html` → **PLAY A LICHESS PLAYER**. The lobby line should read
   *"1 of 1 relay seat free"*. If it reports a token problem, fix that first —
   the message says whether the token is unknown to Lichess or lacks `board:play`.
2. Pick a time control and press **FIND A LICHESS OPPONENT**. The seek is now live
   in the Lichess pool; you can watch it appear at <https://lichess.org/#hook>
   while it waits. Pairing usually takes seconds at 5+0.
3. When it pairs, the header shows the real opponent's username and rating, and
   **View this game on lichess.org** opens the same game on Lichess — the proof
   that this is a genuine Lichess game against a genuine Lichess player.
4. Play a few moves. Moves you make appear on lichess.org; theirs appear on your
   board within a moment (the function long-polls the Lichess board stream rather
   than polling on a timer).
5. **RESIGN** (or **ABORT** in the first move or two) ends the game on Lichess and
   returns the seat to the pool.

### Troubleshooting

| Symptom | Cause |
| --- | --- |
| "Lichess play is not configured on this server" | No `LICHESS_TOKENS` secret — do step 3.4. |
| "Lichess rejected the relay token … needs board:play" | Token lacks the scope, or was revoked. Re-do step 3.2. |
| "All … relay seat(s) are in use right now" | Every token is already in a game. Add more tokens. |
| Stuck on "Waiting for a Lichess player…" | Nobody has accepted the seek yet. Longer time controls pair more slowly; check <https://lichess.org/#hook>. |
| "Lichess is rate-limiting the relay account" | Too many requests on that account; the relay backs that seat off for a minute automatically. |

---

## 4. (Optional) Enable Realtime for instant updates

The client works with 5-second polling out of the box, so this is optional.
For instant move delivery, enable **Realtime → Broadcast** on the project
(on by default for new projects). If Realtime is unavailable the client silently
falls back to polling — multiplayer still works.

---

## 5. Deploy the frontend

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
