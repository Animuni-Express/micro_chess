#!/usr/bin/env bash
# Verifies a Lichess relay token before (or after) deploying: does lichess.org
# recognise it, does it carry the board:play scope the relay needs, and which
# account will Micro Chess guests be seen as?
#
# Usage:
#   bash scripts/check-lichess-token.sh              # reads LICHESS_TOKENS from .env
#   bash scripts/check-lichess-token.sh lip_xxxxxxx  # checks one token directly
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/.env"

if [ "$#" -ge 1 ]; then
  RAW="$1"
elif [ -f "$ENV_FILE" ]; then
  RAW="$(grep -E '^LICHESS_(TOKENS|API_TOKEN|TOKEN)=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
else
  echo "error: pass a token, or create .env with LICHESS_TOKENS=..." >&2
  exit 1
fi

if [ -z "${RAW:-}" ]; then
  echo "error: no token found." >&2
  exit 1
fi

STATUS=0
IFS=',' read -ra TOKENS <<< "$RAW"
for RAW_TOKEN in "${TOKENS[@]}"; do
  TOKEN="$(echo "$RAW_TOKEN" | tr -d '[:space:]')"
  [ -z "$TOKEN" ] && continue
  echo "== ${TOKEN:0:8}…${TOKEN: -4}"

  # POST /api/token/test takes the token in the body, so it also reports the
  # scopes of a token that is too limited to call /api/account.
  TEST="$(curl -sS -m 20 -d "$TOKEN" https://lichess.org/api/token/test || true)"
  if [ -z "$TEST" ] || echo "$TEST" | grep -q '"'"$TOKEN"'": *null'; then
    echo "   FAIL  lichess.org does not recognise this token (revoked, expired, or mistyped)."
    STATUS=1
    continue
  fi

  SCOPES="$(printf '%s' "$TEST" | sed -n 's/.*"scopes":"\([^"]*\)".*/\1/p')"
  echo "   scopes: ${SCOPES:-<none>}"
  if ! printf '%s' "$SCOPES" | grep -q 'board:play'; then
    echo "   FAIL  missing the 'board:play' scope. Create a new token with"
    echo "         'Play games with the board API' ticked:"
    echo "         https://lichess.org/account/oauth/token/create?scopes[]=board:play"
    STATUS=1
    continue
  fi

  ACCOUNT="$(curl -sS -m 20 -H "Authorization: Bearer $TOKEN" https://lichess.org/api/account || true)"
  USERNAME="$(printf '%s' "$ACCOUNT" | sed -n 's/.*"username":"\([^"]*\)".*/\1/p')"
  if [ -z "$USERNAME" ]; then
    echo "   FAIL  /api/account rejected the token: $ACCOUNT"
    STATUS=1
    continue
  fi
  echo "   OK    relay account: $USERNAME (opponents will see this name)"

  PLAYING="$(curl -sS -m 20 -H "Authorization: Bearer $TOKEN" https://lichess.org/api/account/playing || true)"
  COUNT="$(printf '%s' "$PLAYING" | grep -o '"gameId"' | wc -l | tr -d ' ')"
  echo "         ongoing games on this account: $COUNT (a relayed game needs the account free)"
done

if [ "$STATUS" -ne 0 ]; then
  echo ""
  echo "One or more tokens are unusable — 'PLAY A LICHESS PLAYER' will fail until they are fixed."
fi
exit "$STATUS"
