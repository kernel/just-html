// GET /auth.md — prose registration instructions for agents (§2.3). Served as
// text/markdown; charset=utf-8. Verbatim from the spec draft.
export const dynamic = "force-static";

const AUTH_MD = `# justhtml.sh auth.md

This file tells agents how to sign up for justhtml.sh and authenticate API requests.

justhtml.sh hosts HTML documents at stable URLs. It supports the auth.md
user-claimed flow (service_auth variant) with exactly one ceremony: you
register with the human's email, justhtml.sh emails them a 6-digit code, the
human reads the code back to you, and you submit it to complete the claim. It
does not currently support agent-verified ID-JAG registration or anonymous
accounts.

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

## Registration flow

There is exactly one flow. We email the human a 6-digit code; the human reads it
back to you; you submit it. No links to click, no forms, no variants.

First, ask the human for consent to create or recover justhtml.sh API
credentials for their email, and tell them the key will carry scopes
\`docs.read docs.write\` (publish and edit HTML documents as them).

### 1. Register

    POST https://justhtml.sh/agent/identity
    Content-Type: application/json

    { "type": "service_auth", "login_hint": "human@example.com" }

This emails the human a 6-digit code and returns a \`claim_token\` (hold it in
memory only; never show it to anyone except this service). The \`user_code\` is
NOT in the response — it only reaches the human's inbox.

    {
      "claim_token": "clm_...",
      "claim_token_expires": "2026-06-13T17:31:25Z",
      "claim": {
        "complete_url": "https://justhtml.sh/agent/identity/claim/complete",
        "expires_in": 600,
        "interval": 5
      }
    }

### 2. Tell the human to check their email

> I sent a 6-digit code to your email from justhtml.sh. Check your inbox and
> tell me the code.

### 3. Collect the code and complete the claim

When the human gives you the code, submit it:

    POST https://justhtml.sh/agent/identity/claim/complete
    Content-Type: application/json

    { "claim_token": "clm_...", "user_code": "428117" }

A correct code returns \`200 { "status": "claimed" }\`. A wrong code returns
\`401 invalid_user_code\` with the number of attempts remaining; after 5 wrong
tries the code is dead (\`410 code_dead\`) — re-mint (see below).

### 4. Get the API key

After a successful complete, exchange the claim for the key:

    POST https://justhtml.sh/oauth2/token
    Content-Type: application/x-www-form-urlencoded

    grant_type=urn:workos:agent-auth:grant-type:claim&claim_token=clm_...

You may poll this from the moment you register: before the human completes the
code it returns \`{ "error": "authorization_pending" }\` — wait \`claim.interval\`
seconds (5) and retry; on \`slow_down\`, add at least 5 seconds. Once the code is
accepted it returns \`access_token\` — a long-lived API key starting with
\`jh_live_\`, returned exactly once. There is no refresh ceremony; the key works
until revoked.

### If the code expires

If the code expires before the human reads it back (\`expired_token\` from the
token endpoint while the registration is still active), mint a fresh one:

    POST https://justhtml.sh/agent/identity/claim
    Content-Type: application/json

    { "claim_token": "clm_...", "email": "human@example.com" }

This emails a fresh code and invalidates the old one — tell the human to check
their email again. Resume from step 3. If it returns \`410 claim_expired\`, the
registration itself has expired — restart from step 1.

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
