// Zod schemas for the auth surface — the agent claim ceremony
// (POST /agent/identity, /agent/identity/claim, /agent/identity/claim/complete),
// OAuth (POST /oauth2/token, /oauth2/revoke), and the two .well-known discovery
// docs (Z4 of the code-first OpenAPI migration).
//
// IMPORTANT — these are REGISTERED FOR SPEC GENERATION + DRIFT PROTECTION, not as
// the runtime validators. The auth handlers' parsing is deliberately idiosyncratic
// and security-sensitive (capability negotiation with type-specific error codes in
// /agent/identity, isEmailish, the explicit claim_delivery rejection, the
// constant-time 6-digit code compare + 5-attempt budget in claim/complete, the
// RFC 8628 authorization_pending/slow_down polling state machine in /oauth2/token,
// the RFC 7009 idempotent revoke, and the application/x-www-form-urlencoded bodies
// on /oauth2/*). The task's golden rule for these endpoints: register the schema
// for spec coverage while leaving the handler parsing AS-IS so the wire bytes are
// untouched. So unlike the docs resource, NO auth handler calls these via
// safeParse — they exist solely so scripts/gen-spec.ts can emit the agent/oauth
// paths and scripts/spec-check.ts can prove the registry covers 100% of the served
// spec's paths.
//
// Shapes + descriptions/examples are carried over VERBATIM from the hand-written
// lib/openapi/spec-yaml.ts auth section so the generated spec is as rich.

import { z, registry } from "@/lib/openapi/registry";
import { SCOPES } from "@/lib/auth/config";

const dateTime = z.string().openapi({ format: "date-time" });

// =========================================================================
// Shared components (mirror the hand-written ClaimBlock / AgentError / OAuthError).
// =========================================================================

// ClaimBlock — the claim block returned by /agent/identity (as `claim`) and
// /agent/identity/claim (as `claim_attempt`). The user_code is intentionally
// omitted; it is emailed to the human (the only place it appears).
export const ClaimBlock = registry.register(
  "ClaimBlock",
  z
    .object({
      complete_url: z.string().openapi({
        format: "uri",
        description: "POST {claim_token, user_code} here to complete the claim.",
      }),
      expires_in: z.number().int().openapi({ example: 600 }),
      interval: z.number().int().openapi({ example: 5 }),
    })
    .openapi("ClaimBlock", {
      description:
        "The claim block. The user_code is intentionally omitted — it is emailed to the human (the only place it appears). The human reads it back to the agent, which POSTs {claim_token, user_code} to complete_url (/agent/identity/claim/complete).",
    })
);

// AgentError — the {error, message} envelope the /agent/* ceremony emits (agentError()).
export const AgentError = registry.register(
  "AgentError",
  z
    .object({ error: z.string(), message: z.string() })
    .openapi("AgentError", { description: "Agent ceremony error: { error, message }." })
);

// OAuthError — the {error, error_description?} envelope the /oauth2/* endpoints emit.
export const OAuthError = registry.register(
  "OAuthError",
  z
    .object({ error: z.string(), error_description: z.string().optional() })
    .openapi("OAuthError", { description: "OAuth error envelope (RFC 6749): { error, error_description? }." })
);

// =========================================================================
// Request bodies.
// =========================================================================

// POST /agent/identity body: { type: service_auth, login_hint }.
export const StartRegistrationBody = registry.register(
  "StartRegistrationBody",
  z
    .object({
      type: z.enum(["service_auth"]).openapi({ description: "The registration type." }),
      login_hint: z
        .string()
        .openapi({ format: "email", example: "you@example.com", description: "The human's email address." }),
    })
    .openapi("StartRegistrationBody", {
      description: "Start a service_auth registration; the 6-digit code is emailed to login_hint.",
    })
);

// POST /agent/identity/claim body: { claim_token, email }.
export const RemintClaimBody = registry.register(
  "RemintClaimBody",
  z
    .object({
      claim_token: z.string(),
      email: z.string().openapi({ format: "email", description: "Corrected email; updates the registration's login_hint." }),
    })
    .openapi("RemintClaimBody", { description: "Re-mint an expired code; a fresh code is emailed to the human." })
);

// POST /agent/identity/claim/complete body: { claim_token, user_code }.
export const CompleteClaimBody = registry.register(
  "CompleteClaimBody",
  z
    .object({
      claim_token: z.string(),
      user_code: z.string().openapi({ example: "428117", pattern: "^[0-9]{6}$" }),
    })
    .openapi("CompleteClaimBody", {
      description: "Complete a claim by reading the emailed 6-digit code back to the agent.",
    })
);

// POST /oauth2/token body (application/x-www-form-urlencoded): { grant_type, claim_token }.
export const TokenForm = registry.register(
  "TokenForm",
  z
    .object({
      grant_type: z
        .enum(["urn:workos:agent-auth:grant-type:claim"])
        .openapi({ description: "The claim grant type." }),
      claim_token: z.string(),
    })
    .openapi("TokenForm", { description: "Claim-grant token request (form-encoded)." })
);

// POST /oauth2/revoke body (application/x-www-form-urlencoded): { token, token_type_hint? }.
export const RevokeForm = registry.register(
  "RevokeForm",
  z
    .object({
      token: z.string(),
      token_type_hint: z.enum(["access_token"]).optional(),
    })
    .openapi("RevokeForm", { description: "RFC 7009 revocation request (form-encoded)." })
);

// =========================================================================
// Success responses.
// =========================================================================

// POST /agent/identity 200.
export const StartRegistrationResponse = registry.register(
  "StartRegistrationResponse",
  z
    .object({
      registration_id: z.string(),
      registration_type: z.enum(["service_auth"]),
      claim_url: z.string().openapi({ format: "uri" }),
      claim_token: z.string().openapi({ description: "Secret; returned once. Hold in memory only." }),
      claim_token_expires: dateTime,
      post_claim_scopes: z.array(z.string()).openapi({ example: [...SCOPES] }),
      claim: ClaimBlock,
    })
    .openapi("StartRegistrationResponse", {
      description: "Pending registration created; code emailed to the human.",
    })
);

// POST /agent/identity/claim 200.
export const RemintClaimResponse = registry.register(
  "RemintClaimResponse",
  z
    .object({
      registration_id: z.string(),
      claim_attempt_id: z.string(),
      status: z.string().openapi({ example: "initiated" }),
      claim_attempt: ClaimBlock,
    })
    .openapi("RemintClaimResponse", { description: "Fresh code emailed." })
);

// POST /agent/identity/claim/complete 200.
export const CompleteClaimResponse = registry.register(
  "CompleteClaimResponse",
  z
    .object({
      registration_id: z.string(),
      status: z.string().openapi({ example: "claimed" }),
      message: z.string(),
    })
    .openapi("CompleteClaimResponse", { description: "Claim confirmed; poll /oauth2/token for the key." })
);

// POST /oauth2/token 200.
export const TokenResponse = registry.register(
  "TokenResponse",
  z
    .object({
      access_token: z.string().openapi({ example: "jh_live_..." }),
      token_type: z.enum(["Bearer"]),
      scope: z.string().openapi({ example: "docs.read docs.write" }),
      credential_type: z.enum(["api_key"]),
      registration_id: z.string(),
    })
    .openapi("TokenResponse", { description: "Credential issued (once)." })
);

// =========================================================================
// .well-known discovery metadata. The hand-written spec models both as a bare
// `type: object` (open shape, no declared properties), so we register matching
// open objects to keep the generated success-response shape identical.
// =========================================================================

export const ProtectedResourceMetadata = registry.register(
  "ProtectedResourceMetadata",
  z
    .object({})
    .catchall(z.unknown())
    .openapi("ProtectedResourceMetadata", { description: "RFC 9728 protected-resource metadata." })
);

export const AuthServerMetadata = registry.register(
  "AuthServerMetadata",
  z
    .object({})
    .catchall(z.unknown())
    .openapi("AuthServerMetadata", { description: "RFC 8414 authorization-server metadata (with agent_auth block)." })
);
