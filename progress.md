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
