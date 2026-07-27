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
 * The other origins this deployment legitimately answers on.
 *
 * Vercel gives every preview deployment its own hostnames, so a login form POST
 * there carries an Origin that is not ORIGIN — originOk would reject it with
 * "bad origin", and a magic link built from ORIGIN would send the reviewer to
 * production instead of back to the preview they were testing.
 *
 * These hostnames come from Vercel's own runtime env — server-provided, NOT read
 * off the request — so a forged Host header can never widen the set. That is the
 * distinction that matters: linkOrigin puts a single-use login token into an
 * email, and trusting the request's Host there would let an attacker POST with
 * Host: evil.com and have the victim's login link delivered to their domain.
 *
 * Empty in production, where ORIGIN stays the only accepted answer.
 */
function deploymentOrigins(): string[] {
  if (process.env.VERCEL_ENV === "production") return [];
  const out: string[] = [];
  // VERCEL_URL is the immutable per-deployment host; VERCEL_BRANCH_URL is the
  // branch alias. A reviewer may be on either, so both count.
  for (const host of [process.env.VERCEL_URL, process.env.VERCEL_BRANCH_URL]) {
    if (host) out.push(`https://${host}`);
  }
  if (!process.env.VERCEL_ENV) {
    const port = process.env.PORT || "3000";
    out.push(`http://localhost:${port}`, `http://127.0.0.1:${port}`);
  }
  return out;
}

/** The origin this request actually arrived on, per the edge's forwarded headers. */
function requestOrigin(req: Request): string | null {
  try {
    const u = new URL(req.url);
    const host = req.headers.get("x-forwarded-host") || u.host;
    const proto = req.headers.get("x-forwarded-proto") || u.protocol.replace(":", "");
    return host ? `${proto}://${host}` : null;
  } catch {
    return null;
  }
}

/**
 * Origin-header CSRF check for mutating browser POSTs (§9.4). If an Origin
 * header is present and is not one of ours, the request is cross-site → reject.
 * Absent Origin (some same-origin form posts, curl) is allowed; SameSite=Lax is
 * the primary defense and the Origin check is the second factor.
 *
 * Cross-site POSTs stay rejected everywhere: a browser sets Origin itself, so an
 * attacker page can never present one of our deployment origins.
 */
export function originOk(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (origin == null) return true;
  if (origin === ORIGIN) return true;
  return deploymentOrigins().includes(origin);
}

/**
 * The origin to build an emailed link from: the one the request arrived on when
 * that is a host this deployment owns (a preview, or local dev), else the
 * canonical ORIGIN. So a login started on a preview finishes on that same
 * preview, while production and any unrecognized Host always link to ORIGIN.
 */
export function linkOrigin(req: Request): string {
  const origin = requestOrigin(req);
  if (origin && deploymentOrigins().includes(origin)) return origin;
  return ORIGIN;
}
