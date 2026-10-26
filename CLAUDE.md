# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Common Development Commands:
- Build production bundle: `bun run build` (esbuild)
- Start development server: `bun run dev` (live-reload server)
- Test execution: bun run test (Node test runner, protocol/chess/PostgreSQL tests)

Project Architecture:
- Vanilla web stack (HTML/CSS/JS) with PWA capabilities
- Stockfish.js for AI opponent
- chess.js for game logic
- Netlify Edge Functions and temporary PostgreSQL for multiplayer rendezvous; WebRTC for gameplay
- Service Workers for offline functionality

Key Implementation Areas:
- Progressive Web App (PWA) with offline caching
- AI-powered chess engine integration
- Responsive design for multi-device support
- Specialized modes for Kindle/e-ink optimization