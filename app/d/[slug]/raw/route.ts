import { findBySlug } from "@/lib/docs/store";
import { canViewSession } from "@/lib/docs/access";
import { verifyViewCap } from "@/lib/docs/viewcap";
import { getSession } from "@/lib/auth/session";
import { clientIp } from "@/lib/auth/request";
import { checkLimits } from "@/lib/auth/ratelimit";
import { RL_VIEWER_PER_MIN } from "@/lib/docs/config";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string }> };

// GET /d/:slug/raw — the actual user HTML, served origin-less (sandboxed) so it
// can never execute same-origin with our auth/session surface (birthday.md "The
// one security decision that matters").
//
//   Content-Security-Policy: sandbox allow-scripts  → the response is treated as
//     a unique opaque origin; scripts run but cannot read our cookies / tokens or
//     reach our origin's storage.
//   X-Content-Type-Options: nosniff                 → no MIME sniffing.
//
// Directly linkable for zero-chrome viewing; same token rules as /d/:slug.
//
// Viewer rate limit: per-IP (the sandbox + token model is the real protection;
// this just caps scraping). The per-minute cap is mapped onto the hourly counter
// bucket (×60) since the rate_limits table buckets hourly — see lib/docs/api.ts.
const VIEWER_PER_HOUR = RL_VIEWER_PER_MIN * 60;

function deny(status: number, msg: string): Response {
  return new Response(msg, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  const ip = clientIp(req);
  const tripped = await checkLimits([
    ip ? { key: `viewer:ip:${ip}`, limit: VIEWER_PER_HOUR, window: "hour" } : null,
  ]);
  if (tripped) {
    return new Response("Too many requests.", {
      status: 429,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Retry-After": String(tripped.retryAfter),
      },
    });
  }

  const { slug } = await ctx.params;
  const url = new URL(req.url);
  const viewtoken = url.searchParams.get("viewtoken");
  const cap = url.searchParams.get("cap");

  const doc = await findBySlug(slug);
  // No existence oracle for private docs: a missing doc and a private doc the
  // viewer can't access are both 404.
  if (!doc) return deny(404, "Not found.");
  // Authorization (birthday.md "Viewer-route enforcement"): owner session →
  // email grant → domain grant → view token → public. When /raw is loaded inside
  // the sandboxed iframe the session cookie is NOT sent (opaque origin, Lax), so
  // the shell instead appends a short-lived, slug-scoped HMAC capability (?cap=);
  // verifying it here is equivalent to the session re-authorizing this exact doc
  // (the shell only mints a cap after canViewSession passed). This replaces the
  // old approach of handing the iframe the doc's master view_token, which leaked
  // the un-share token to grantees. When /raw is opened as a top-level link the
  // session cookie IS sent and authorizes directly via canViewSession. A real
  // ?viewtoken= (capability URL) still works on either path.
  if (cap && verifyViewCap(cap, slug)) {
    // cap authorized — fall through to serve (it proves a prior session check).
  } else {
    const session = await getSession(req);
    if (!(await canViewSession(doc, session, viewtoken))) return deny(404, "Not found.");
  }

  return new Response(doc.html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "sandbox allow-scripts",
      "X-Content-Type-Options": "nosniff",
      // Never cache private content at shared caches; tokens are capability URLs.
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}
