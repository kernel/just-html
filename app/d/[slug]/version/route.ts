import { getSessionReadOnly } from "@/lib/auth/session";
import { canView, canViewSession } from "@/lib/docs/access";
import { findVersionBySlug } from "@/lib/docs/version-cache";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string }> };

function notFound(): Response {
  return new Response(null, { status: 404 });
}

export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  const { slug } = await ctx.params;
  const doc = await findVersionBySlug(slug);
  if (!doc) return notFound();

  const viewtoken = new URL(req.url).searchParams.get("viewtoken");
  if (!canView(doc, viewtoken)) {
    const session = await getSessionReadOnly(req);
    if (!(await canViewSession(doc, session, null))) return notFound();
  }

  return new Response(String(doc.version), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "private, no-store",
    },
  });
}
