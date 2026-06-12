import { ORIGIN } from "@/lib/auth/config";

// Per-request helpers: client IP, user-agent, and the Origin-header CSRF check
// for browser form POSTs (§9.4).

/**
 * Best-effort client IP from Vercel's forwarding headers. Returns null when no
 * IP is derivable — callers skip the per-IP rate-limit check rather than reject
 * (§6, "skip the IP check when no IP is derivable").
 */
export function clientIp(req: Request): string | null {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = req.headers.get("x-real-ip");
  return real?.trim() || null;
}

export function userAgent(req: Request): string | null {
  return req.headers.get("user-agent");
}

/**
 * Origin-header CSRF check for mutating browser POSTs (§9.4). If an Origin
 * header is present and is not our origin, the request is cross-site → reject.
 * Absent Origin (some same-origin form posts, curl) is allowed; SameSite=Lax is
 * the primary defense and the Origin check is the second factor.
 */
export function originOk(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (origin == null) return true;
  return origin === ORIGIN;
}
