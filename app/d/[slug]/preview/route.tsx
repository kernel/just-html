import { ImageResponse } from "next/og";
import { findBySlug } from "@/lib/docs/store";
import { canView } from "@/lib/docs/access";
import { documentPreview } from "@/lib/docs/preview";
import { clientIp } from "@/lib/auth/request";
import { checkLimits } from "@/lib/auth/ratelimit";
import { RL_VIEWER_PER_MIN } from "@/lib/docs/config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ slug: string }> };

const VIEWER_PER_HOUR = RL_VIEWER_PER_MIN * 60;

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
  const viewtoken = new URL(req.url).searchParams.get("viewtoken");
  const doc = await findBySlug(slug);

  // Image crawlers do not share the viewer's browser session. A private preview
  // is available only when its own URL carries the document's view token; this
  // keeps titles and descriptions hidden for bare private slugs.
  if (!doc || !canView(doc, viewtoken)) {
    return new Response("Not found.", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const preview = documentPreview(doc);
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "72px 80px",
          color: "#1c2024",
          background: "#f6f4ed",
          fontFamily: "monospace",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <div
            style={{
              width: 46,
              height: 46,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "#81b300",
              color: "#1c2024",
              fontSize: 23,
              fontWeight: 700,
            }}
          >
            K
          </div>
          <div style={{ display: "flex", fontSize: 22, letterSpacing: 2, color: "#60646c" }}>
            JUSTHTML.SH · DOCUMENT
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 24, maxWidth: 1040 }}>
          <div style={{ display: "flex", fontSize: 58, lineHeight: 1.08, letterSpacing: -2 }}>
            {preview.imageTitle}
          </div>
          <div style={{ display: "flex", fontSize: 26, lineHeight: 1.42, color: "#60646c" }}>
            {preview.imageDescription}
          </div>
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            paddingTop: 26,
            borderTop: "2px solid #d0d2d9",
            color: "#60646c",
            fontSize: 20,
          }}
        >
          <div style={{ display: "flex" }}>justhtml.sh/d/{doc.slug}</div>
          <div style={{ display: "flex", color: "#5e8300" }}>{doc.is_public ? "public" : "shared link"}</div>
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
      headers: {
        "Cache-Control": doc.is_public ? "public, max-age=300" : "private, no-store",
        ...(doc.is_public ? {} : { "X-Robots-Tag": "noindex, nofollow, noimageindex" }),
      },
    }
  );
}
