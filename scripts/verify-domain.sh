#!/usr/bin/env bash
# verify-domain.sh — confirm the justhtml.sh apex domain is verified, the cert
# issues, and the apex serves. Run this AFTER the required TXT record has been
# added to DNS (see "Domain verification" in README.md).
#
# This re-asks Vercel to verify the domain attachment, prints the verification
# state, and then probes the live apex. No redeploy is needed once the TXT
# record lands — Vercel verifies and issues the cert on its own.
#
# Usage:  ./scripts/verify-domain.sh
# Reads VERCEL_TOKEN / VERCEL_PROJECT_ID / VERCEL_ORG_ID from .env.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOMAIN="${DOMAIN:-justhtml.sh}"

if [ -f "$ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ROOT/.env"
  set +a
fi

: "${VERCEL_TOKEN:?set VERCEL_TOKEN (in .env)}"
: "${VERCEL_PROJECT_ID:?set VERCEL_PROJECT_ID (in .env)}"
: "${VERCEL_ORG_ID:?set VERCEL_ORG_ID (in .env)}"

API="https://api.vercel.com"
AUTH=(-H "Authorization: Bearer $VERCEL_TOKEN")

PYFMT='
import sys, json
d = json.load(sys.stdin)
print("verified:", d.get("verified"))
for v in (d.get("verification") or []):
    print("  {} {} = {}".format(v.get("type"), v.get("domain"), v.get("value")))
'

echo "== 1. required TXT record (what DNS must contain) =="
curl -sS "${AUTH[@]}" \
  "$API/v9/projects/$VERCEL_PROJECT_ID/domains/$DOMAIN?teamId=$VERCEL_ORG_ID" \
  | python3 -c "$PYFMT"

echo
echo "== 2. is the TXT record live in DNS? =="
dig +short TXT "_vercel.$DOMAIN" || true

echo
echo "== 3. ask Vercel to (re)verify =="
curl -sS -X POST "${AUTH[@]}" \
  "$API/v9/projects/$VERCEL_PROJECT_ID/domains/$DOMAIN/verify?teamId=$VERCEL_ORG_ID"
echo

echo
echo "== 4. probe the live apex =="
echo "-- https://$DOMAIN/api/health --"
curl -sS -m 20 "https://$DOMAIN/api/health" || echo "(apex not serving yet — cert may still be issuing)"
echo
echo
echo "Expected once verified: step 1 shows verified: True, and step 4 prints"
echo '{"ok":true,"db":true}. If verified is still False, the TXT record above is'
echo "not yet visible to Vercel — re-check DNS and re-run."
