import { authenticate, authFail, type ApiPrincipal } from "@/lib/auth/bearer";
import { checkLimits } from "@/lib/auth/ratelimit";
import { audit } from "@/lib/auth/audit";
import { WWW_AUTHENTICATE_CHALLENGE } from "@/lib/auth/config";
import {
  MAX_TITLE_LEN,
  RL_CREATES_PER_HOUR,
  RL_READS_PER_MIN,
  RL_WRITES_PER_MIN,
} from "@/lib/docs/config";

// Shared API helpers for /api/v1/docs/*: JSON envelopes, scope checks, structured
// quota/limit responses, and per-key rate limiting.
//
// Rate-limit windows match the published Limits table exactly (birthday.md: limits
// are documented "so agents can plan around them", so documented == enforced):
// writes 60/min, reads 300/min (minute bucket), doc creates 60/hr (hour bucket).
// The rate_limits counter keys on (key, window_start) and now supports a 'minute'
// window via date_trunc('minute', now()), so no migration is required.

const JSON_CT = "application/json; charset=utf-8";

export function json(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": JSON_CT, ...(headers ?? {}) },
  });
}

/** Generic structured API error: { error, message, ...extra }. */
export function apiError(
  status: number,
  error: string,
  message: string,
  extra?: Record<string, unknown>
): Response {
  return json({ error, message, ...(extra ?? {}) }, status);
}

/** 403 when the key lacks a required scope. */
export function forbiddenScope(scope: string): Response {
  return apiError(403, "insufficient_scope", `This credential lacks the required scope: ${scope}.`);
}

export function hasScope(principal: ApiPrincipal, scope: string): boolean {
  return principal.scopes.includes(scope);
}

/** 404 for a missing/inaccessible doc (no existence oracle for non-owners). */
export function notFoundDoc(): Response {
  return apiError(404, "not_found", "No such document.");
}

/** 413 — request body / doc html exceeds the size cap. */
export function payloadTooLarge(limitBytes: number, gotBytes: number): Response {
  return apiError(413, "payload_too_large", "HTML exceeds the per-document size limit.", {
    limit_bytes: limitBytes,
    got_bytes: gotBytes,
  });
}

/**
 * 422 — a domain grant targets a consumer email provider (granting @gmail.com
 * is granting the world). Suggests is_public or the view token instead
 * (birthday.md "Permissions model"). Structured so the calling agent can pivot.
 */
export function consumerDomainRejected(domain: string): Response {
  return apiError(
    422,
    "consumer_domain_not_allowed",
    `Refusing to grant a whole consumer email provider ('${domain}') — anyone can get an address there, so this would share the document with the world. To share broadly, set the document public (PATCH { "public": true }) or hand out the view token. To share with a real organization, grant its own domain (e.g. 'kernel.sh') or specific email addresses.`,
    { domain, suggestions: ["set_public", "view_token", "specific_email", "org_domain"] }
  );
}

/** 403 quota_exceeded — count or storage cap hit. */
export function quotaExceeded(
  kind: "doc_count" | "storage" | "grants",
  limit: number,
  current: number
): Response {
  const msg =
    kind === "doc_count"
      ? "You have reached the maximum number of documents."
      : kind === "grants"
        ? "This document has reached the maximum number of grants. Revoke an existing grant before adding another."
        : "You have reached your total storage limit.";
  return apiError(403, "quota_exceeded", msg, { limit: kind, limit_value: limit, current });
}

/**
 * 422 — a patch edit could not be applied deterministically (birthday.md
 * "Editing"). Names the failing edit index and a machine-readable reason so the
 * calling agent can retry with more context. `extra` carries reason-specific
 * detail (other_edit_index for overlap, occurrences for multiple_matches).
 */
export function unprocessableEdit(
  reason: string,
  editIndex: number,
  message: string,
  extra?: Record<string, unknown>
): Response {
  return apiError(422, "edit_failed", message, {
    reason,
    edit_index: editIndex,
    ...(extra ?? {}),
  });
}

/** 409 — base_version mismatch (stale patch). Carries the current version. */
export function staleVersion(currentVersion: number): Response {
  return apiError(
    409,
    "version_conflict",
    "base_version does not match the document's current version. Re-read the document (or GET /versions), re-derive your edits against the current content, and retry.",
    { current_version: currentVersion, versions_url: "versions" }
  );
}

export type RlKind = "create" | "write" | "read";

/**
 * Per-key rate limit (birthday.md "API rate limits"). Returns a 429 Response if
 * tripped, else null. Keyed by api_key_id so limits are per credential.
 */
export async function rateLimit(
  req: Request,
  principal: ApiPrincipal,
  kind: RlKind
): Promise<Response | null> {
  const k = `docs:${kind}:key:${principal.apiKeyId}`;
  const check =
    kind === "create"
      ? { key: k, limit: RL_CREATES_PER_HOUR, window: "hour" as const }
      : kind === "write"
        ? { key: k, limit: RL_WRITES_PER_MIN, window: "minute" as const }
        : { key: k, limit: RL_READS_PER_MIN, window: "minute" as const };
  const tripped = await checkLimits([check]);
  if (!tripped) return null;
  audit(req, "rate_limit.tripped", {
    apiKeyId: principal.apiKeyId,
    userId: principal.userId,
    meta: { key: tripped.key, limit: tripped.limit },
  });
  return json(
    {
      error: "rate_limited",
      message: `Too many requests. Retry after ${tripped.retryAfter} seconds.`,
      retry_after: tripped.retryAfter,
    },
    429,
    { "Retry-After": String(tripped.retryAfter) }
  );
}

/**
 * The shared 5-step preamble every /api/v1/docs/* handler runs:
 *   authenticate → (401 authFail) → hasScope → (403 forbiddenScope) → rate-limit.
 * Returns the principal on success, or the Response to return on any failure.
 * Collapses ~11 copy-pasted blocks into one call. Behavior is byte-identical to
 * the inlined version: same 401 message split (missing vs invalid), same 403
 * insufficient_scope body, same 429 from rateLimit().
 */
export async function requireApiKey(
  req: Request,
  scope: string,
  rlKind: RlKind
): Promise<{ principal: ApiPrincipal } | { response: Response }> {
  const principal = await authenticate(req);
  if (!principal) return { response: authFail(req) };
  if (!hasScope(principal, scope)) return { response: forbiddenScope(scope) };
  const limited = await rateLimit(req, principal, rlKind);
  if (limited) return { response: limited };
  return { principal };
}

/**
 * 401 for the comment/reaction identity routes (API key OR session). Same status
 * + Content-Type + WWW-Authenticate as the API Bearer 401; the message varies per
 * route (e.g. "Reacting requires…", "Commenting requires…"). Replaces four
 * hand-rolled, divergent 401 helpers; the resource_metadata URL comes from the
 * single-sourced WWW_AUTHENTICATE_CHALLENGE in config.ts.
 */
export function unauthorizedIdentity(message: string): Response {
  return new Response(JSON.stringify({ error: "unauthorized", message }), {
    status: 401,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "WWW-Authenticate": WWW_AUTHENTICATE_CHALLENGE,
    },
  });
}

/**
 * Parse a JSON request body that must be a plain object. Folds in the optional
 * Content-Length 413 precheck (maxBytes) used by the html/edits routes. Returns
 * the parsed object (typed Record<string, unknown>) or the Response to return:
 *   - 413 payload_too_large if Content-Length exceeds maxBytes (when provided),
 *   - 400 invalid_request "must be valid JSON" on a parse failure,
 *   - 400 invalid_request "must be a JSON object" for a non-object / null body.
 */
export async function parseJsonObject(
  req: Request,
  opts?: { maxBytes?: number }
): Promise<{ obj: Record<string, unknown> } | { response: Response }> {
  if (opts?.maxBytes !== undefined) {
    const contentLength = Number(req.headers.get("content-length") ?? "");
    if (Number.isFinite(contentLength) && contentLength > opts.maxBytes) {
      return { response: payloadTooLarge(opts.maxBytes, contentLength) };
    }
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return { response: apiError(400, "invalid_request", "Request body must be valid JSON.") };
  }
  if (typeof body !== "object" || body === null) {
    return { response: apiError(400, "invalid_request", "Request body must be a JSON object.") };
  }
  return { obj: body as Record<string, unknown> };
}

/**
 * Validate a required positive-integer path param (grant id, comment id, reaction
 * id, version number). Returns the integer or a 400 invalid_request Response. The
 * message is unified ("<Name> must be a positive integer.") — status + error code
 * are unchanged from the divergent inlined checks.
 */
export function parsePositiveIntParam(
  name: string,
  raw: string
): { value: number } | { response: Response } {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    return { response: apiError(400, "invalid_request", `${name} must be a positive integer.`) };
  }
  return { value: n };
}

/**
 * Validate a title field. `required` distinguishes POST (title optional, but if
 * present must be a string ≤ cap) from PATCH (title may be null to clear it).
 * Returns the resolved title (string | null) or a 400 Response.
 *   - POST semantics (allowNull=false): undefined/null → null; else must be a
 *     string ≤ MAX_TITLE_LEN.
 *   - PATCH semantics (allowNull=true): null → null (clears); else string ≤ cap.
 * Status codes preserved; message strings unified.
 */
export function parseTitle(
  value: unknown,
  opts: { allowNull: boolean }
): { title: string | null } | { response: Response } {
  if (value === undefined || value === null) {
    return { title: null };
  }
  if (typeof value !== "string") {
    const expected = opts.allowNull ? "a string or null" : "a string";
    return { response: apiError(400, "invalid_request", `Field 'title' must be ${expected}.`) };
  }
  if (value.length > MAX_TITLE_LEN) {
    return {
      response: apiError(400, "invalid_request", `Field 'title' must be at most ${MAX_TITLE_LEN} characters.`),
    };
  }
  return { title: value };
}

/**
 * Validate an optional boolean field (public, notify). Returns the boolean, or
 * the supplied default when the field is absent (undefined), or a 400 Response
 * when present-but-not-a-boolean. Status codes preserved; message unified.
 */
export function parseOptionalBool(
  value: unknown,
  field: string,
  defaultValue: boolean
): { value: boolean } | { response: Response } {
  if (value === undefined) return { value: defaultValue };
  if (typeof value !== "boolean") {
    return { response: apiError(400, "invalid_request", `Field '${field}' must be a boolean.`) };
  }
  return { value };
}
