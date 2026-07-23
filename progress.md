Original prompt: Implement multiplayer chess with private rooms and time-control matchmaking.

- Added as an isolated online mode so the existing over-the-board, Stockfish, and Kindle flows remain unchanged.
- Backend deployment still requires applying the Supabase migration and deploying the multiplayer Edge Function after local verification.
- Implemented the isolated online frontend, Supabase migration, and multiplayer Edge Function; next step is build and browser validation.
- The production build passes outside the filesystem sandbox; esbuild requires parent-directory reads that the sandbox blocks.
- Installed Playwright and prepared the prescribed browser-test client; Chromium must run outside the sandbox in this environment.
- Fixed Realtime updates so a broadcast never overwrites the receiving player's own color; each client retains its authenticated color from the game fetch.

Multiplayer completion + hardening pass:
- Removed leftover merge-conflict markers in index.html that were rendering as page text.
- Fixed a Kindle crash: the online clock used String.prototype.padStart (ES2017), which old Kindle WebKit lacks and which the ES5 build does not polyfill. Added padStart/padEnd shims to src/kindle/polyfills.js.
- Fixed desktop error messaging: supabase-js wraps non-2xx Edge Function responses in a generic "non-2xx status code" error; the client now reads the real message from the response body so users see "Room not found", "It is not your turn", etc. (matching the Kindle path).
- Removed the 93MB supabase.exe binary accidentally committed to the repo and gitignored *.exe.
- Verified end-to-end with a headless-Chromium harness (mock backend mirroring the Edge Function): page render + no-console-error checks on all desktop and Kindle pages; OTB checkmate; Stockfish engine-blocked fallback; online rooms create/join/move-sync/draw (desktop), matchmaking + fool's-mate checkmate over the wire (desktop), rooms + resign (Kindle), and real-error-message surfacing. All green across repeated runs.
- Verified Kindle old-WebKit resilience by running polyfills.js in a fresh V8 realm with the modern built-ins deleted (padStart, Set, Promise, fetch, Object.assign, Array.from/find, String methods, Function.bind) — every shim installs and behaves.
- Still required for production: apply the Supabase migration and deploy the multiplayer Edge Function to the project (the frontend is verified against a spec-compliant backend; live-backend reachability is blocked from the build sandbox by egress policy).

Second hardening pass (live-site feedback):
- Bumped the service-worker cache to micro-chess-v10 so a redeploy actually evicts the stale index.html (users were still being served the cached conflict-marker version).
- Board rendering: added a Unicode chess-glyph fallback. Board's <img> now has an onError that hides the broken image and reveals a text-glyph sibling, so browsers that cannot render SVG-in-<img> (some old Kindle e-ink browsers) still show pieces instead of blank/broken squares. Verified in-browser by aborting all piece SVG requests and asserting 32 visible sized glyphs.
- Desktop client now reads the Edge Function's real error body (text, then JSON) so "Edge Function returned a non-2xx status code" is replaced by the actual reason (e.g. a DB error if the migration isn't applied).
- Restored the desktop Stockfish setup menu that the Preact migration dropped: PLAY AS white/black, AI LEVEL 1-20, AI ENGINE (Chess-API / Lichess / Supabase / Local), START GAME — mirroring the Kindle flow, with the engine-unreachable fallback move preserved.
- Test coverage: mock-backend Chromium harness (14 checks) + Kindle-viewport render harness with SVG-failure + missing-built-ins simulations (5 checks) + node:vm polyfill simulation (23 checks). All green across repeated runs.

Third pass (post-merge live bug report — "Game access denied"):
- Root cause: the "COPY LINK" button on a waiting room shares a URL keyed by game id (?game=<uuid>). A friend opening that link is a fresh guest who isn't a recognized player yet, so get_game rejects them with "Game access denied" — there was never a way to actually JOIN via that link, only the separate room-code text field worked.
- Fix: added a join_multiplayer_game_by_id RPC (new migration 20260723150000_join_by_game_id.sql, mirrors join_multiplayer_room but keyed by id) and a join_by_id Edge Function action. Both clients (desktop OnlineGameApp.jsx, Kindle KindleOnlineGameApp.jsx) now fall back from get_game to join_by_id when access is denied AND the player has never been seated in this game before (tracked via a ref so a later, unrelated denial is never misread as an invite).
- Added Playwright coverage for the exact bug: a second browser context opens the shared link directly (never touching the room-code field) and must end up seated with the opposite colour, no "access denied" message. 44/44 checks green (16 functional + 23 polyfill + 5 Kindle-render), stable across repeated runs.
- Requires another one-time backend step: apply the new migration (supabase db push, or paste it into the SQL Editor) and redeploy the multiplayer Edge Function — see DEPLOY.md.
