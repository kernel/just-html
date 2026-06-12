import { findBySlug } from "@/lib/docs/store";
import { canViewSession, canView } from "@/lib/docs/access";
import { mintViewCap } from "@/lib/docs/viewcap";
import { getSession } from "@/lib/auth/session";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import {
  resolveCommentPrincipal,
  resolveCapability,
  allThreads,
} from "@/lib/docs/comments";
import CommentsShell from "./CommentsShell";
import PlainShell from "./PlainShell";

export const dynamic = "force-dynamic";

// GET /d/:slug — the viewer shell. THIRD React surface (birthday.md "Production
// architecture"), but only when it earns its keep:
//
//   - Zero comments AND a viewer who cannot comment → the PLAIN shell: thin
//     chrome (title + "made with justhtml.sh") wrapping the sandboxed iframe,
//     no rail, no overlay, no client JS — behaviorally identical to the pre-B10
//     page.
//   - ≥1 comment OR a viewer who CAN comment → the variant-B comments shell:
//     right rail, highlights, selection toolbar. The user HTML still renders in
//     the origin-less sandboxed iframe; the rail lives in the shell and talks to
//     an injected overlay (raw?overlay=1) via postMessage.
//
// Token rules identical to /raw: owner session → email/domain grant → view token
// → public; otherwise the "private or does not exist" notice (no existence
// oracle). The root layout provides <html>/<body> + the monospace brand; these
// components render body content only.

type Props = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ [k: string]: string | string[] | undefined }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const doc = await findBySlug(slug);
  const title = doc ? (doc.title || doc.slug) : "private";
  return { title: `${title} — justhtml.sh` };
}

async function reconstructRequest(): Promise<Request> {
  // The comment principal/session helpers read cookies + Authorization off a
  // Request. In a server component we read them from next/headers and rebuild a
  // minimal Request so we reuse the exact same auth code paths the API uses.
  const h = await headers();
  const hdrs = new Headers();
  const cookie = h.get("cookie");
  if (cookie) hdrs.set("cookie", cookie);
  const auth = h.get("authorization");
  if (auth) hdrs.set("authorization", auth);
  return new Request("https://justhtml.sh/d", { headers: hdrs });
}

export default async function ViewerPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const sp = await searchParams;
  const rawToken = sp.viewtoken;
  const viewtoken = Array.isArray(rawToken) ? (rawToken[0] ?? null) : (rawToken ?? null);

  const doc = await findBySlug(slug);
  const req = await reconstructRequest();
  const session = await getSession(req);

  if (!doc || !(await canViewSession(doc, session, viewtoken))) {
    // No existence oracle: missing slug and unauthorized private doc both render
    // the same notice with a real 404 (the nearest not-found boundary).
    notFound();
  }

  // Iframe src (same logic as the pre-B10 shell): a real ?viewtoken= passes
  // through; public docs need no token; a session-authorized private viewer gets
  // a short-lived, slug-scoped cap (NOT the master view_token).
  let rawQuery = "";
  if (viewtoken) rawQuery = `?viewtoken=${encodeURIComponent(viewtoken)}`;
  else if (!doc.is_public) rawQuery = `?cap=${encodeURIComponent(mintViewCap(slug))}`;

  // Can this viewer comment? (Drives whether the rail is interactive.)
  const principal = await resolveCommentPrincipal(null, session);
  let canComment = false;
  if (principal) {
    const cap = await resolveCapability(doc, principal, canView(doc, viewtoken));
    canComment = cap.canComment;
  }

  const threadData = await allThreads(doc);
  const hasComments = threadData.total > 0;
  const title = doc.title || doc.slug;

  // Cold path: no comments AND this viewer can't comment → plain shell.
  if (!hasComments && !canComment) {
    return <PlainShell title={title} rawSrc={`/d/${encodeURIComponent(slug)}/raw${rawQuery}`} />;
  }

  // Comments shell: overlay-injected iframe + the variant-B rail.
  const overlayQuery = rawQuery ? `${rawQuery}&overlay=1` : "?overlay=1";
  return (
    <CommentsShell
      slug={slug}
      title={title}
      rawSrc={`/d/${encodeURIComponent(slug)}/raw${overlayQuery}`}
      viewtoken={viewtoken}
      canComment={canComment}
      signedIn={session !== null}
      initialThreads={threadData.threads}
      version={doc.version}
    />
  );
}

