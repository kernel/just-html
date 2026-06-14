import { oauthEmpty, oauthError } from "@/lib/auth/responses";
import { clientIp } from "@/lib/auth/request";
import { enforceRateLimit } from "@/lib/auth/ratelimit";
import { query } from "@/lib/db";
import { sha256Hex } from "@/lib/auth/tokens";
import { audit } from "@/lib/auth/audit";

export const dynamic = "force-dynamic";

// POST /oauth2/revoke (RFC 7009, §3.4) — idempotent. Returns 200 empty whether
// or not the token existed or was already revoked (no enumeration). 400 only on
// a malformed body.
export async function POST(req: Request): Promise<Response> {
  const ip = clientIp(req);
  const tripped = await enforceRateLimit(req, [
    ip ? { key: `revoke:ip:${ip}`, limit: 30, window: "hour" } : null,
  ]);
  if (tripped) {
    return oauthError("rate_limited", `Retry after ${tripped.retryAfter} seconds.`, {
      status: 429,
      headers: { "Retry-After": String(tripped.retryAfter) },
    });
  }

  let form: URLSearchParams;
  try {
    form = new URLSearchParams(await req.text());
  } catch {
    return oauthError("invalid_request", "Malformed form body.");
  }
  const token = form.get("token");
  if (!token) {
    return oauthError("invalid_request", "token: required.");
  }

  // Flip revoked_at only on a currently-live key; audit only when a key flipped.
  const { rows } = await query<{ id: number; user_id: number }>(
    `UPDATE api_keys SET revoked_at = now()
     WHERE token_hash = $1 AND revoked_at IS NULL
     RETURNING id, user_id`,
    [sha256Hex(token)]
  );
  if (rows[0]) {
    audit(req, "token.revoked", {
      userId: rows[0].user_id,
      apiKeyId: rows[0].id,
      meta: { api_key_id: rows[0].id },
    });
  }

  return oauthEmpty();
}
