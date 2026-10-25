# Multiplayer migration verification

Implemented JavaScript Netlify Edge APIs, temporary PostgreSQL rooms, atomic matchmaking, binary WebRTC moves and ACKs, digest validation, IndexedDB recovery, reconnect generations, presence challenges, finish consensus and scheduled expiry cleanup. Desktop and Kindle have independent presentation components. Kindle uses the Stockfish-style block layout and remains an ES5 build.

Verified on 2026-10-25:
- 21 Node protocol/chess/session/PostgreSQL tests passed.
- Both migrations applied through Netlify CLI to the local development database.
- Real Chrome browser contexts passed private rooms, public matchmaking, moves, refresh recovery, resignation, agreed draws and checkmate.
- Four legal moves plus P2P heartbeats produced zero multiplayer HTTP requests while active.
- Kindle ES5 UI created a room, played against desktop, and resigned; simulated missing-WebRTC fallback loaded; Kindle Stockfish setup and local board passed.
- Production build passed; cleanup Function compiled; repository search has no remaining integration references; git diff --check passed.

Netlify MCP confirmed the micro-chess site and no site environment variables. No production deploy or hosted database migration was performed. TURN fallback is supported but a relay/secret was not provided; restricted-network relay behavior and physical Kindle hardware are unverified. See DEPLOY.md for configuration and hosting constraints.

The generated bundles present before this task were copied to ignored .netlify/pre-migration before rebuilding. The original Bun lockfile was backed up to .netlify/pre-bun before migrating the current dependency graph.

Bun migration: packageManager and Netlify builds pin Bun 1.4.4. bun.lock is authoritative; package-lock.json was removed after backup. Frozen offline installation and all 21 tests passed. Node remains the runtime for the existing tests and Netlify CLI.
Bun verification completed: production build (including Kindle ES5), Netlify Dev startup and the complete browser regression suite passed through bun run. Direct dependency versions match the pre-migration npm lockfile. Test server stopped; production remains unchanged.
