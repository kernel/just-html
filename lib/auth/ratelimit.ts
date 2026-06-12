import { query } from "@/lib/db";

// Fixed-window rate limiting on Postgres counters (§6). One atomic
// upsert-and-return per check. Increment-then-check: rejected requests still
// consume budget (correct for abuse control). Fail OPEN on store errors.

export type Window = "hour" | "day";

export type LimitCheck = {
  /** counter key, e.g. 'ident:ip:1.2.3.4' | 'login:email:raf@kernel.sh' */
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
  return w === "day" ? "date_trunc('day', now())" : "date_trunc('hour', now())";
}

function secondsToReset(w: Window): number {
  const now = new Date();
  if (w === "day") {
    const next = new Date(now);
    next.setUTCHours(24, 0, 0, 0);
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
