#!/usr/bin/env bash
# Pushes the Lichess relay secrets from .env into the Supabase project, where the
# `lichess` Edge Function reads them. Run this after creating or rotating a token.
#
# The token never leaves your machine and Supabase — it is not in git (.env is
# gitignored) and is never sent to the browser.
#
# Prerequisites:
#   - Supabase CLI installed: https://supabase.com/docs/guides/cli
#   - Logged in:              supabase login
#   - A .env file:            cp .env.example .env && edit
#
# Usage:
#   bash scripts/set-lichess-secrets.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/.env"
PROJECT_REF="${SUPABASE_PROJECT_REF:-}"

if [ ! -f "$ENV_FILE" ]; then
  echo "error: $ENV_FILE not found. Copy .env.example to .env and add your token." >&2
  exit 1
fi

# shellcheck disable=SC1090
PROJECT_REF="${PROJECT_REF:-$(grep -E '^SUPABASE_PROJECT_REF=' "$ENV_FILE" | tail -1 | cut -d= -f2-)}"
PROJECT_REF="${PROJECT_REF:-ncsqidwsimmdbkoiidlz}"

if ! grep -qE '^LICHESS_(TOKENS|API_TOKEN|TOKEN)=..*' "$ENV_FILE"; then
  echo "error: no LICHESS_TOKENS (or LICHESS_API_TOKEN) value in $ENV_FILE." >&2
  exit 1
fi

# Supabase reserves the SUPABASE_ prefix and rejects secrets that use it, so push
# only the LICHESS_* keys.
FILTERED="$(mktemp)"
trap 'rm -f "$FILTERED"' EXIT
grep -E '^LICHESS_[A-Z_]+=' "$ENV_FILE" > "$FILTERED"

echo "==> Setting $(wc -l < "$FILTERED" | tr -d ' ') Lichess secret(s) on project $PROJECT_REF..."
supabase secrets set --env-file "$FILTERED" --project-ref "$PROJECT_REF"

echo ""
echo "==> Done. Confirm what is set (values stay hidden):"
echo "    supabase secrets list --project-ref $PROJECT_REF"
echo "==> Then verify the relay end to end:"
echo "    open /online.html -> PLAY A LICHESS PLAYER (the lobby prints how many seats are free)"
