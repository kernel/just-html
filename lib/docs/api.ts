import type { ApiPrincipal } from "@/lib/auth/bearer";
import { checkLimits } from "@/lib/auth/ratelimit";
import { audit } from "@/lib/auth/audit";
import {
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
