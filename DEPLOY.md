# Micro Chess multiplayer deployment

All application and Netlify code is JavaScript. The current frontend uses Preact and chess.js; Kindle has its own block-based UI and an ES5 bundle.

## Local verification

Requires Bun 1.4.4 and Node 22.12+. Bun manages dependencies and scripts; the existing Node test runner and Netlify CLI retain their Node runtime. Use `bun run test`, not Bun's separate `bun test` runner. The project-local CLI is available through `bun run netlify`.

```powershell
bun install --frozen-lockfile
bun run test
bun run build
bun run netlify link --id b635821c-f4ec-44ca-94cb-a42c12c6c0fe
bun run netlify dev --offline
# In another terminal, while Netlify Dev is running:
bun run netlify database migrations apply
```

Open http://localhost:8888/online.html in two separate browser profiles/contexts. Create a private room in one, join its six-character code in the other. Public matchmaking uses the same connection flow. The separate contexts prevent recovery storage from being shared between the test players. A second tab of an existing game is fenced with Web Locks.

`bun run test` runs protocol, chess, session and PostgreSQL integration tests with the official Netlify local database runtime. `bun run test:browser` exercises actual browser contexts against the running Netlify Dev server. Production durations are fixed in `src/multiplayer/config.js`; session tests inject shorter timings without changing shipped defaults.

## Hosting

`netlify.toml` publishes only the explicit static allowlist in `dist/`. Source, migrations, credentials and local database files are excluded. Do not publish the repository root. Normal API requests use the JavaScript Edge Function at `/api/multiplayer/*`; the scheduled JavaScript Function only removes expired temporary records.

Commit the SQL migration under `netlify/database/migrations/` as part of the reviewed change. Netlify applies migrations during deployment; do not apply SQL directly to a hosted database. Keep existing databases in place. New database provisioning follows the site's configured Functions region; select Singapore (`sin`) in Netlify before first provisioning when the plan permits it. The linked site currently uses Ohio (`cmh`); its plan rejects custom Function regions, so the preview uses that existing region. Singapore (`sin`) needs a plan supporting region selection before provisioning there. Existing sites/databases may have a different region, which requires a separately planned migration rather than destructive recreation.

The configured site is `micro-chess` (`b635821c-f4ec-44ca-94cb-a42c12c6c0fe`). Building locally does not publish it. Production deployment requires an explicit release request.

## Connection configuration

No database credentials are shipped to the browser. Netlify supplies `NETLIFY_DB_URL` at runtime. Temporary 256-bit browser tokens are hashed with SHA-256 before entering PostgreSQL; credentials use request bodies or headers rather than URLs.

Optional Netlify Functions-scoped variables:

- `MULTIPLAYER_STUN_URL`: STUN URL (default `stun:stun.l.google.com:19302`).
- `MULTIPLAYER_TURN_URLS`: JSON array of TURN/TURNS URLs for an available compatible relay.
- `MULTIPLAYER_TURN_SECRET`: relay's shared HMAC secret, kept server-side. The Edge Function issues credentials valid for ten minutes; it never sends the shared secret.

A relay is needed for networks where direct WebRTC is blocked. No relay has been provisioned by this repository. Netlify hosts the rendezvous and database; it does not supply a TURN relay. Without these optional settings, only direct/STUN connectivity can be verified. Browsers lacking WebRTC, Web Crypto, IndexedDB or Web Locks show a compatibility message; old Kindle WebKit still loads the dedicated UI and retains local chess modes.

## Temporary state and lifecycle

Rooms last at most 24 hours; unjoined rooms expire after ten minutes, abandoned connecting rooms after five. Matchmaking expires after two minutes; signaling after two minutes. Reconnect has a 90-second deadline. Cleanup runs every ten minutes. Active games produce no HTTP heartbeats, move calls or database writes. Peer health uses binary PING/PONG. After five minutes on one turn, the opponent sends a presence challenge; only intentional game interaction answers it. A deliberately interacting player can still stall an untimed game.

The ordered reliable `microchess` channel uses a six-byte header: protocol byte, type byte, and big-endian uint32 sequence. MOVE is 25 bytes (squares, promotion, 128-bit digest), MOVE_ACK is 22, terminal packets are seven, others six. Health packets do not depend on move sequence. Presence packets use a random challenge identifier in the sequence field. JSON is restricted to HTTP and HELLO/READY handshakes. Position digests include all six FEN fields and complete UCI history, preserving repetition state. Reconnect replays and verifies both histories and retains their longest compatible prefix; conflicting moves fail closed.

Both participants must confirm the same terminal result before immediate deletion. A one-sided claim leaves a short-lived finishing record for fallback expiry. Cascading deletion removes seats, tokens, checkpoints, signaling and matched queue rows. Completed local IndexedDB state is removed. No accounts or permanent game archive are created.
