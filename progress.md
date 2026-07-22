Original prompt: Implement multiplayer chess with private rooms and time-control matchmaking.

- Added as an isolated online mode so the existing over-the-board, Stockfish, and Kindle flows remain unchanged.
- Backend deployment still requires applying the Supabase migration and deploying the multiplayer Edge Function after local verification.
- Implemented the isolated online frontend, Supabase migration, and multiplayer Edge Function; next step is build and browser validation.
- The production build passes outside the filesystem sandbox; esbuild requires parent-directory reads that the sandbox blocks.
- Installed Playwright and prepared the prescribed browser-test client; Chromium must run outside the sandbox in this environment.
- Fixed Realtime updates so a broadcast never overwrites the receiving player's own color; each client retains its authenticated color from the game fetch.
