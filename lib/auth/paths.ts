// Register the auth-surface PATHS into the shared OpenAPIRegistry (Z4): the agent
// claim ceremony, OAuth token/revoke, and the two .well-known discovery docs.
// Importing this module (side-effecting) wires the operations + their schemas so
// scripts/gen-spec.ts emits the agent/oauth/.well-known paths and the registry
// covers 100% of the served hand-written spec's paths.
//
// All summaries/descriptions are carried over from the hand-written
// lib/openapi/spec-yaml.ts auth + discovery sections so the generated spec is as
// rich. Every operation is `security: []` (the ceremony + discovery are
// unauthenticated — the API key is the OUTPUT of the ceremony), matching the
// hand-written spec's per-operation `security: []`.
//
// NOTE (parity with the served spec): the auth handlers are NOT migrated to Zod
// (their parsing is idiosyncratic + security-sensitive — see lib/auth/schemas.ts).
// These registrations are spec-coverage + drift-protection only.

import { registry } from "@/lib/openapi/registry";
import {
  AgentError,
  AuthServerMetadata,
  ClaimBlock,
  CompleteClaimBody,
  CompleteClaimResponse,
  OAuthError,
  ProtectedResourceMetadata,
  RemintClaimBody,
  RemintClaimResponse,
  RevokeForm,
  StartRegistrationBody,
  StartRegistrationResponse,
  TokenForm,
  TokenResponse,
} from "@/lib/auth/schemas";

// Ensure the shared components ClaimBlock is registered even though it is only
// referenced transitively (registry.register already ran at import).
void ClaimBlock;

const jsonAgentError = { "application/json": { schema: AgentError } };
const jsonOAuthError = { "application/json": { schema: OAuthError } };

// POST /agent/identity — start a service_auth registration
registry.registerPath({
  method: "post",
  path: "/agent/identity",
  tags: ["auth"],
  summary: "Start a service_auth registration",
  description:
    "Creates a pending registration (no user account is created yet), emails the human a 6-digit code, and returns a claim_token plus a claim block. There is exactly one flow: justhtml.sh emails the login_hint the code (the code and nothing else — no links). The user_code is NEVER returned in the response (the email is the binding proof). The human reads the code back to the agent, which submits it to POST /agent/identity/claim/complete; the agent then polls /oauth2/token for the key. There is no claim_delivery parameter, no approve link, and no hosted claim form.",
  operationId: "startRegistration",
  security: [],
  request: {
    body: { required: true, content: { "application/json": { schema: StartRegistrationBody } } },
  },
  responses: {
    200: {
      description: "Pending registration created; code emailed to the human",
      content: { "application/json": { schema: StartRegistrationResponse } },
    },
    400: {
      description:
        "Bad body, bad login_hint, unsupported type, or a now-removed parameter (claim_delivery is rejected with invalid_request).",
      content: jsonAgentError,
    },
    429: { description: "Rate limit exceeded", content: jsonAgentError },
    503: {
      description: "email_send_failed — the code email could not be sent; the registration is voided. Retry registration.",
      content: jsonAgentError,
    },
  },
});

// POST /agent/identity/claim — re-mint an expired code
registry.registerPath({
  method: "post",
  path: "/agent/identity/claim",
  tags: ["auth"],
  summary: "Re-mint an expired code",
  description:
    "Invalidates the prior code and emails a fresh 6-digit code (the 24h registration window must still be open). A corrected email updates the registration's login_hint. The new code is NOT returned in the response — it goes to the human's inbox.",
  operationId: "remintClaim",
  security: [],
  request: {
    body: { required: true, content: { "application/json": { schema: RemintClaimBody } } },
  },
  responses: {
    200: {
      description: "Fresh code emailed",
      content: { "application/json": { schema: RemintClaimResponse } },
    },
    400: { description: "Bad body", content: jsonAgentError },
    401: { description: "Unknown claim_token", content: jsonAgentError },
    409: { description: "Already claimed", content: jsonAgentError },
    410: { description: "Registration window closed", content: jsonAgentError },
    429: { description: "Rate limit exceeded", content: jsonAgentError },
  },
});

// POST /agent/identity/claim/complete — complete a claim by reading the code back
registry.registerPath({
  method: "post",
  path: "/agent/identity/claim/complete",
  tags: ["auth"],
  summary: "Complete a claim by reading the emailed code back",
  description:
    "The human reads the 6-digit code from the emailed message back to the agent, which submits it here to confirm the claim WITHOUT a browser session (the binding proof is that the code only reached the human via their inbox). Constant-time compare; 5 wrong attempts kill the code (410 code_dead), then re-mint via POST /agent/identity/claim. On success the agent's /oauth2/token poll returns the key.",
  operationId: "completeClaim",
  security: [],
  request: {
    body: { required: true, content: { "application/json": { schema: CompleteClaimBody } } },
  },
  responses: {
    200: {
      description: "Claim confirmed; poll /oauth2/token for the key",
      content: { "application/json": { schema: CompleteClaimResponse } },
    },
    400: { description: "Bad body", content: jsonAgentError },
    401: {
      description:
        "invalid_claim_token (unknown token) or invalid_user_code (wrong code; message names attempts remaining).",
      content: jsonAgentError,
    },
    409: { description: "claimed_or_in_flight (already claimed).", content: jsonAgentError },
    410: {
      description:
        "claim_expired (registration window closed), code_dead (5 wrong attempts), or expired_token (user_code window closed). Re-mint.",
      content: jsonAgentError,
    },
    429: { description: "Rate limit exceeded", content: jsonAgentError },
  },
});

// POST /oauth2/token — poll the claim grant for the API key
registry.registerPath({
  method: "post",
  path: "/oauth2/token",
  tags: ["auth"],
  summary: "Poll the claim grant for the API key",
  description:
    "RFC 8628-style polling. While the human has not finished, returns 400 authorization_pending (or slow_down if polled under 5s apart). On confirm, returns the long-lived API key exactly once.",
  operationId: "claimGrantToken",
  security: [],
  request: {
    body: {
      required: true,
      content: { "application/x-www-form-urlencoded": { schema: TokenForm } },
    },
  },
  responses: {
    200: {
      description: "Credential issued (once)",
      headers: { "Cache-Control": { schema: { type: "string" }, description: "no-store" } },
      content: { "application/json": { schema: TokenResponse } },
    },
    400: {
      description:
        "OAuth error envelope. error one of: authorization_pending, slow_down, expired_token, invalid_grant, invalid_request, unsupported_grant_type.",
      content: jsonOAuthError,
    },
    429: { description: "Rate limit exceeded", content: jsonOAuthError },
  },
});

// POST /oauth2/revoke — revoke an API key (RFC 7009)
registry.registerPath({
  method: "post",
  path: "/oauth2/revoke",
  tags: ["auth"],
  summary: "Revoke an API key (RFC 7009)",
  description: "Idempotent. Returns 200 with an empty body whether or not the token existed.",
  operationId: "revokeToken",
  security: [],
  request: {
    body: {
      required: true,
      content: { "application/x-www-form-urlencoded": { schema: RevokeForm } },
    },
  },
  responses: {
    200: { description: "Revoked (or no-op); empty body" },
    400: { description: "Malformed body", content: jsonOAuthError },
    429: { description: "Rate limit exceeded", content: jsonOAuthError },
  },
});

// GET /.well-known/oauth-protected-resource — RFC 9728 protected-resource metadata
registry.registerPath({
  method: "get",
  path: "/.well-known/oauth-protected-resource",
  tags: ["discovery"],
  summary: "RFC 9728 protected-resource metadata",
  operationId: "protectedResourceMetadata",
  security: [],
  responses: {
    200: {
      description: "Resource metadata",
      content: { "application/json": { schema: ProtectedResourceMetadata } },
    },
  },
});

// GET /.well-known/oauth-authorization-server — RFC 8414 authorization-server metadata
registry.registerPath({
  method: "get",
  path: "/.well-known/oauth-authorization-server",
  tags: ["discovery"],
  summary: "RFC 8414 authorization-server metadata (with agent_auth block)",
  operationId: "authServerMetadata",
  security: [],
  responses: {
    200: {
      description: "Authorization-server metadata",
      content: { "application/json": { schema: AuthServerMetadata } },
    },
  },
});
