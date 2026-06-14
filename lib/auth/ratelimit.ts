import { query } from "@/lib/db";
import { audit } from "@/lib/auth/audit";

// Fixed-window rate limiting on Postgres counters (§6). One atomic
// upsert-and-return per check. Increment-then-check: rejected requests still
// consume budget (correct for abuse control). Fail OPEN on store errors.

export type Window = "minute" | "hour" | "day";

export type LimitCheck = {
  /** counter key, e.g. 'ident:ip:1.2.3.4' | 'email:addr:raf@kernel.sh' */
  key: string;
  limit: number;
  window: Window;
};

export type RateResult = {
  ok: boolean;
  /** seconds until the current window resets (for Retry-After) */
  retryAfter: number;
};

function windowStartExpr(w: Window): string {
  return w === "day"
    ? "date_trunc('day', now())"
    : w === "minute"
      ? "date_trunc('minute', now())"
      : "date_trunc('hour', now())";
}

function secondsToReset(w: Window): number {
  const now = new Date();
  if (w === "day") {
    const next = new Date(now);
    next.setUTCHours(24, 0, 0, 0);
    return Math.max(1, Math.ceil((next.getTime() - now.getTime()) / 1000));
  }
  if (w === "minute") {
    const next = new Date(now);
    next.setUTCSeconds(60, 0);
    return Math.max(1, Math.ceil((next.getTime() - now.getTime()) / 1000));
  }
  const next = new Date(now);
  next.setUTCHours(now.getUTCHours() + 1, 0, 0, 0);
  return Math.max(1, Math.ceil((next.getTime() - now.getTime()) / 1000));
}

/**
 * Atomically increment one counter and report whether it is now over `limit`.
 * Fails open (returns ok:true) if the counter query errors (§6).
 */
export async function bump(check: LimitCheck): Promise<RateResult> {
  try {
    const { rows } = await query<{ count: number }>(
      `INSERT INTO rate_limits (key, window_start)
       VALUES ($1, ${windowStartExpr(check.window)})
       ON CONFLICT (key, window_start)
       DO UPDATE SET count = rate_limits.count + 1
       RETURNING count`,
      [check.key]
    );
    // Probabilistic GC of stale rows (~1% of inserts), no cron dependency.
    if (Math.random() < 0.01) {
      query(`DELETE FROM rate_limits WHERE window_start < now() - interval '48 hours'`).catch(
        () => {}
      );
    }
    const count = rows[0]?.count ?? 0;
    if (count > check.limit) {
      return { ok: false, retryAfter: secondsToReset(check.window) };
    }
    return { ok: true, retryAfter: 0 };
  } catch {
    return { ok: true, retryAfter: 0 }; // fail open
  }
}

// Email-send rate caps (authmd-implementation.md §6 #11–13), shared by every
// surface that sends a Resend email keyed to a recipient address: /login magic
// links AND B9 email-delivery registration (claim email). Checked in spec order
// (per-IP, per-email, then global).
//
// RECALIBRATED 2026-06-12 (founder directive, post-dogfood) — OUR CHOICE:
//   - per-IP 10/h -> 30/h: offices/NAT share an IP; our own QA and the human
//     shared one IP during dogfooding and the human got 429'd.
//   - global 50/h -> 500/h: the global cap exists ONLY as a Resend cost /
//     runaway circuit breaker, so it must sit FAR above organic traffic. A
//     global cap at user scale lets one abuser deny login to everyone.
//   - per-email 5/h + 20/day: UNCHANGED (inbox-bombing protection).
export const EMAIL_SEND_PER_IP_PER_H = 30;
export const EMAIL_SEND_PER_EMAIL_PER_H = 5;
export const EMAIL_SEND_PER_EMAIL_PER_DAY = 20;
export const EMAIL_SEND_GLOBAL_PER_H = 500;

/**
 * The email-send rate-limit checks for a recipient + IP, in spec order. Returns
 * a list to splice into a checkLimits() call. Keyed on the lowercased email.
 */
export function EMAIL_SEND_LIMITS(
  email: string,
  ip: string | null
): Array<LimitCheck | null> {
  return [
    ip ? { key: `email:ip:${ip}`, limit: EMAIL_SEND_PER_IP_PER_H, window: "hour" } : null,
    { key: `email:addr:${email}`, limit: EMAIL_SEND_PER_EMAIL_PER_H, window: "hour" },
    { key: `email:addr:day:${email}`, limit: EMAIL_SEND_PER_EMAIL_PER_DAY, window: "day" },
    { key: "email:global", limit: EMAIL_SEND_GLOBAL_PER_H, window: "hour" },
  ];
}

/**
 * Run a list of checks in order (spec order: per-IP, per-email, then global —
 * §6). Returns the first failure, or ok. Checks with a null key (e.g. no IP
 * derivable) are skipped.
 */
export async function checkLimits(
  checks: Array<LimitCheck | null>
): Promise<{ key: string; limit: number; retryAfter: number } | null> {
  for (const c of checks) {
    if (!c) continue;
    const res = await bump(c);
    if (!res.ok) return { key: c.key, limit: c.limit, retryAfter: res.retryAfter };
  }
  return null;
}

/**
 * Run the checks and, on a trip, emit the standard audit event before
 * returning the tripped result. This is the one place the
 * `checkLimits → if tripped: audit("rate_limit.tripped") → 429` preamble lives
 * (Theme T5). Returns the tripped result (key/limit/retryAfter) or null if all
 * checks passed. The CALLER maps a non-null result to ITS OWN 429 response —
 * status, Retry-After header, and body wording stay per-handler (the OAuth
 * envelope, the agent JSON envelope, or the /login HTML page), so this helper
 * never decides the response shape.
 */
export async function enforceRateLimit(
  req: Request,
  checks: Array<LimitCheck | null>
): Promise<{ key: string; limit: number; retryAfter: number } | null> {
  const tripped = await checkLimits(checks);
  if (tripped) {
    audit(req, "rate_limit.tripped", {
      meta: { key: tripped.key, limit: tripped.limit },
    });
  }
  return tripped;
}
