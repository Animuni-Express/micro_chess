#!/usr/bin/env bash
# Deploys the Micro Chess multiplayer backend (DB schema + Edge Function) to
# Supabase. Fixes the "Edge Function returned a non-2xx status code" error, which
# means this backend has not been deployed yet.
#
# Prerequisites:
#   - Supabase CLI installed:  https://supabase.com/docs/guides/cli
#   - Logged in:               supabase login
#
# Usage:
#   bash scripts/deploy-supabase.sh
set -euo pipefail

PROJECT_REF="ncsqidwsimmdbkoiidlz"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> Linking project $PROJECT_REF (prompts for the DB password once)..."
supabase link --project-ref "$PROJECT_REF"

echo "==> Pushing migration (creates games/moves/matchmaking_queue + RPCs)..."
supabase db push

echo "==> Deploying the 'multiplayer' Edge Function..."
supabase functions deploy multiplayer --project-ref "$PROJECT_REF"

echo ""
echo "==> Done. Open /online.html in two separate browsers to verify."
echo "    (If 'supabase db push' cannot connect, paste"
echo "     supabase/migrations/20260718000000_multiplayer.sql into the"
echo "     Dashboard SQL Editor instead — see DEPLOY.md.)"
