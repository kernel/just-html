import { RESOURCE, ISSUER, ORIGIN, SCOPES } from "@/lib/auth/config";

// RFC 8414 authorization-server metadata + the agent_auth profile block (§2.2).
// We advertise only what we support: the claim grant, service_auth, api_key
// credential type. No jwt-bearer, no events endpoint, no identity_assertion.
export const dynamic = "force-static";

const BODY = JSON.stringify({
  resource: RESOURCE,
  authorization_servers: [ISSUER],
  scopes_supported: SCOPES,
  bearer_methods_supported: ["header"],

  issuer: ISSUER,
  token_endpoint: `${ORIGIN}/oauth2/token`,
  revocation_endpoint: `${ORIGIN}/oauth2/revoke`,
  grant_types_supported: ["urn:workos:agent-auth:grant-type:claim"],

  agent_auth: {
    skill: `${ORIGIN}/auth.md`,
    identity_endpoint: `${ORIGIN}/agent/identity`,
    claim_endpoint: `${ORIGIN}/agent/identity/claim`,
    identity_types_supported: ["service_auth"],
    credential_types_supported: ["api_key"],
  },
});

export function GET(): Response {
  return new Response(BODY, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}
