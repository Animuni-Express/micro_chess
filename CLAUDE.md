# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Common Development Commands:
- Build production bundle: `npm run build` (esbuild)
- Start development server: `npm run dev` (live-reload server)
- Run tests: `npm test` (jest; sources are transformed by esbuild via
  `tests/esbuild-transformer.cjs`, so no Babel toolchain is involved)

Project Architecture:
- Vanilla web stack (HTML/CSS/JS) with PWA capabilities
- Stockfish.js for AI opponent
- chess.js for game logic
- Supabase for backend services (Edge Functions: `multiplayer`, `stockfish`, `lichess`)
- Service Workers for offline functionality

Key Implementation Areas:
- Progressive Web App (PWA) with offline caching
- AI-powered chess engine integration
- Responsive design for multi-device support
- Specialized modes for Kindle/e-ink optimization
- Lichess relay: the `lichess` Edge Function seeks real opponents in the public
  lichess.org pool on shared relay accounts and proxies moves, so anonymous
  visitors play real people without a Lichess account. Secrets (`LICHESS_TOKENS`)
  live in `.env` / Supabase secrets and must never be committed or shipped to the
  browser. See DEPLOY.md section 3.