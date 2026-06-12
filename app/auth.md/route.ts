// GET /auth.md — prose registration instructions for agents (§2.3). Served as
// text/markdown; charset=utf-8. Verbatim from the spec draft.
export const dynamic = "force-static";

const AUTH_MD = `# justhtml.sh auth.md

This file tells agents how to sign up for justhtml.sh and authenticate API requests.

justhtml.sh hosts HTML documents at stable URLs. It supports the auth.md
user-claimed flow (service_auth variant): you register with the human's email
and the human confirms in their browser. By default we email the human a
6-digit code and a one-click approve link — so the human just checks their
inbox; you don't have to relay anything. (A spec-pure mode where you show the
human the code is also available; see "Spec-pure variant" below.) It does not
currently support agent-verified ID-JAG registration or anonymous accounts.

## Before registering

Check for an existing justhtml.sh API key first:

1. Read \`JUSTHTML_API_KEY\` from the process environment.
2. If you are operating inside a project and the human permits it, read
   \`JUSTHTML_API_KEY\` from a local \`.env\` file. Never commit it.
3. Read \`~/.justhtml/credentials\` if it exists, has mode \`0600\`, and contains JSON
   like:

    {
      "api_key": "jh_live_...",
      "created_at": "2026-06-12T00:00:00Z",
      "source": "auth.md"
    }

If you find a candidate key, make a harmless authenticated request such as
\`GET https://justhtml.sh/api/v1/docs?limit=1\`. If it succeeds, use that key. If it
returns 401, discard the stale key and start the flow below.

## Discovery metadata

justhtml.sh publishes OAuth-style metadata at:

- \`https://justhtml.sh/.well-known/oauth-protected-resource\`
- \`https://justhtml.sh/.well-known/oauth-authorization-server\`

The authorization server metadata contains:

- \`agent_auth.skill\`: \`https://justhtml.sh/auth.md\`
- \`agent_auth.identity_endpoint\`: \`https://justhtml.sh/agent/identity\`
- \`agent_auth.claim_endpoint\`: \`https://justhtml.sh/agent/identity/claim\`
- supported identity type: \`service_auth\`
- supported credential type: \`api_key\`

Do not hard-code endpoint paths from examples on other services. Use this file and
the metadata.

## Registration flow (default: email delivery)

Ask the human for consent to create or recover justhtml.sh API credentials for
their email address, and tell them the key will carry scopes \`docs.read docs.write\`
(publish and edit HTML documents as them).

Start registration:

    POST https://justhtml.sh/agent/identity
    Content-Type: application/json

    { "type": "service_auth", "login_hint": "human@example.com" }

By default \`claim_delivery\` is \`"email"\`: justhtml.sh emails the human a 6-digit
code AND a one-click approve link. The response contains a \`claim_token\` (hold
it in memory only; never show it to anyone except this service) and a \`claim\`
block — but in email mode the \`user_code\` is **omitted** (the email is the
binding proof; we don't hand you the code):

    {
      "claim_token": "clm_...",
      "claim": {
        "delivery": "email",
        "code_delivery": "We emailed the code and an approve link ...",
        "complete_url": "https://justhtml.sh/agent/identity/claim/complete",
        "expires_in": 600,
        "interval": 5
      }
    }

Tell the human, in one message:

> Check your email for a justhtml.sh message — click the approve link to
> confirm and sign in, OR tell me the 6-digit code from it and I'll finish.

There are two ways the claim completes; you support BOTH and just poll either way:

(a) The human clicks the approve link in the email. One click confirms the
    key and signs them in. You do nothing but poll.

(b) The human reads the 6-digit code back to you. Submit it:

    POST https://justhtml.sh/agent/identity/claim/complete
    Content-Type: application/json

    { "claim_token": "clm_...", "user_code": "428117" }

    -> 200 { "status": "claimed" } on a correct code. Wrong code -> 401
       invalid_user_code with attempts remaining; after 5 wrong tries the code
       is dead (410 code_dead) — re-mint (see below).

While the human does either, poll for completion:

    POST https://justhtml.sh/oauth2/token
    Content-Type: application/x-www-form-urlencoded

    grant_type=urn:workos:agent-auth:grant-type:claim&claim_token=clm_...

While the human hasn't finished, this returns
\`{ "error": "authorization_pending" }\` — wait \`claim.interval\` seconds (5) and
retry. On \`slow_down\`, add at least 5 seconds to your interval. On success the
response contains \`access_token\` — a long-lived API key starting with \`jh_live_\`,
returned exactly once. There is no refresh ceremony; the key works until revoked.

If the code expires before the human acts (\`expired_token\` from the token
endpoint while the registration is still active), mint a fresh one:

    POST https://justhtml.sh/agent/identity/claim
    Content-Type: application/json

    { "claim_token": "clm_...", "email": "human@example.com" }

This sends a fresh email (new code + new approve link) and invalidates the old
one. Resume polling. If it returns \`410 claim_expired\`, the registration itself
has expired — restart registration.

## Spec-pure variant (claim_delivery: agent)

If you implement the auth.md spec literally — surface the code to the human
yourself, nothing emailed — register with \`claim_delivery: "agent"\`:

    POST https://justhtml.sh/agent/identity
    Content-Type: application/json

    { "type": "service_auth", "login_hint": "human@example.com",
      "claim_delivery": "agent" }

Now the \`claim\` block carries the \`user_code\` and a \`verification_uri\`:

    { "claim": { "delivery": "agent", "user_code": "428117",
                 "verification_uri": "https://justhtml.sh/login?next=...",
                 "expires_in": 600, "interval": 5 } }

Surface both to the human in one message ("open this link, sign in, enter this
6-digit code: 428117"). The code goes into the page they land on — not back to
you. There is no \`/agent/identity/claim/complete\` in this mode (the human enters
the code at the hosted form). Poll \`/oauth2/token\` exactly as above. Re-mint via
\`/agent/identity/claim\` re-surfaces a fresh code + link (no email).

The delivery mode is fixed at registration time and the two are mutually
exclusive (the binding proof differs: emailed-inbox possession vs. a code you
relay). The email default needs the fewest human actions; prefer it unless you
have a reason to relay the code yourself.

## Use the credential

    GET https://justhtml.sh/api/v1/docs
    Authorization: Bearer jh_live_...

To revoke a key: POST \`token=<key>\` (form-encoded) to
\`https://justhtml.sh/oauth2/revoke\`.

## Store the credential

Store the \`access_token\` in the best available secret store for your platform. If
the human allows file storage: \`~/.justhtml/credentials\`, mode \`0600\`, format shown
above. Never print the API key in logs, chat, commits, pull requests, generated
docs, or tool output.

If a later request returns 401, discard the stale credential and restart discovery
from this file.

Full API reference: \`https://justhtml.sh/llms.txt\` and
\`https://justhtml.sh/api/spec.yaml\`.
`;

export function GET(): Response {
  return new Response(AUTH_MD, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}
