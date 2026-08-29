#!/usr/bin/env bash
set -euo pipefail

RULE_NAME="Rate limit document viewer"
PROJECT="${VERCEL_PROJECT:-justhtml}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-${TMPDIR:-/tmp}/justhtml-vercel-cache}"
SCOPE="${VERCEL_SCOPE:-onkernel}"
VERCEL=(npx --yes vercel@59.9.1)
AUTH=()
if [[ -n "${VERCEL_TOKEN:-}" ]]; then
  AUTH=(--token "$VERCEL_TOKEN")
fi
COMMON=(--project "$PROJECT" --scope "$SCOPE" "${AUTH[@]}")

rules="$("${VERCEL[@]}" firewall rules list --json "${COMMON[@]}")"
if jq -e --arg name "$RULE_NAME" '
  .rules[]?
  | select(.name == $name)
  | .active == true
    and .action.mitigate.action == "rate_limit"
    and .action.mitigate.rateLimit.limit == 300
    and .action.mitigate.rateLimit.window == 60
    and .action.mitigate.rateLimit.keys == ["ip"]
    and .action.mitigate.rateLimit.algo == "fixed_window"
    and .conditionGroup == [{"conditions":[{"type":"path","value":"/d/","op":"pre"}]}]
' <<<"$rules" >/dev/null; then
  echo "Viewer firewall rule is already configured."
  exit 0
fi

if jq -e --arg name "$RULE_NAME" '.rules[]? | select(.name == $name)' <<<"$rules" >/dev/null; then
  "${VERCEL[@]}" firewall rules edit "$RULE_NAME" \
    --condition '{"type":"path","op":"pre","value":"/d/"}' \
    --action rate_limit \
    --rate-limit-algo fixed_window \
    --rate-limit-keys ip \
    --rate-limit-requests 300 \
    --rate-limit-window 60 \
    --rate-limit-action rate_limit \
    --enabled --yes "${COMMON[@]}"
else
  "${VERCEL[@]}" firewall rules add "$RULE_NAME" \
    --condition '{"type":"path","op":"pre","value":"/d/"}' \
    --action rate_limit \
    --rate-limit-algo fixed_window \
    --rate-limit-keys ip \
    --rate-limit-requests 300 \
    --rate-limit-window 60 \
    --rate-limit-action rate_limit \
    --yes "${COMMON[@]}"
fi

"${VERCEL[@]}" firewall publish --yes "${COMMON[@]}"
