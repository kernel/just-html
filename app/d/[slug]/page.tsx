import { bookmarkExists, findBySlug } from "@/lib/docs/store";
import { canViewSession, canView } from "@/lib/docs/access";
import { canEdit } from "@/lib/docs/grants";
import { mintViewCap } from "@/lib/docs/viewcap";
import { getSession } from "@/lib/auth/session";
import { linkOrigin } from "@/lib/auth/request";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import {
  resolveCommentPrincipal,
  resolveCapability,
  allThreads,
} from "@/lib/docs/comments";
import { detectServerTheme } from "@/lib/docs/theme";
import { extractSections } from "@/lib/docs/sections";
import { documentPreview } from "@/lib/docs/preview";
import CommentsShell from "./CommentsShell";

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

function readViewToken(sp: { [k: string]: string | string[] | undefined }): string | null {
  const raw = sp.viewtoken;
  return Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null);
}

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const { slug } = await params;
  const sp = await searchParams;
  const viewtoken = readViewToken(sp);
  const doc = await findBySlug(slug);

  // Link-preview metadata follows the document's normal view authorization. In
  // particular, a private slug without its view token must not disclose the
  // document title or description to Slackbot (or any other anonymous caller).
  const req = await reconstructRequest();
  const session = await getSession(req);
  if (!doc || !(await canViewSession(doc, session, viewtoken))) {
    return { title: "justhtml.sh", robots: { index: false, follow: false } };
  }

  const preview = documentPreview(doc);
  // The image request is independent of the page fetch and has no browser
  // session. Private previews therefore carry the same view token in the image
  // URL; session-only private views omit an image rather than minting a public
  // metadata capability. Public documents need no query parameter.
  const baseUrl = `${linkOrigin(req)}/d/${encodeURIComponent(slug)}`;
  const tokenAuthorized = viewtoken !== null && canView(doc, viewtoken);
  const tokenQuery = tokenAuthorized ? `?viewtoken=${encodeURIComponent(viewtoken)}` : "";
  const imageUrl = doc.is_public || tokenAuthorized ? `${baseUrl}/preview${tokenQuery}` : null;
  const pageUrl = `${baseUrl}${tokenQuery}`;
  const images = imageUrl
    ? [{ url: imageUrl, width: 1200, height: 630, alt: preview.title }]
    : undefined;

  return {
    title: `${preview.title} — justhtml.sh`,
    description: preview.description,
    robots: doc.is_public ? undefined : { index: false, follow: false },
    openGraph: {
      type: "article",
      siteName: "justhtml.sh",
      title: preview.title,
      description: preview.description,
      url: pageUrl,
      images,
    },
    twitter: {
      card: imageUrl ? "summary_large_image" : "summary",
      title: preview.title,
      description: preview.description,
      images: imageUrl ? [imageUrl] : undefined,
    },
  };
}

async function reconstructRequest(): Promise<Request> {
  // The comment principal/session helpers read cookies + Authorization off a
  // Request. In a server component we read them from next/headers and rebuild a
  // minimal Request so we reuse the exact same auth code paths the API uses.
  // Forwarded host/proto let linkOrigin keep preview images on Vercel previews.
  const h = await headers();
  const hdrs = new Headers();
  const cookie = h.get("cookie");
  if (cookie) hdrs.set("cookie", cookie);
  const auth = h.get("authorization");
  if (auth) hdrs.set("authorization", auth);
  for (const name of ["x-forwarded-host", "x-forwarded-proto"]) {
    const value = h.get(name);
    if (value) hdrs.set(name, value);
  }
  return new Request("https://justhtml.sh/d", { headers: hdrs });
}

export default async function ViewerPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const sp = await searchParams;
  const viewtoken = readViewToken(sp);

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

  // Can this viewer comment, react, and/or edit? (Drives whether the rail is
  // interactive, whether the selection toolbar offers comment/react, and whether
  // the bar offers inline edit mode.) Editing is deliberately the narrowest of the
  // three — owner or editor grant only, straight off the same resolved access, so
  // a view-token holder who may comment still cannot type into the document.
  const principal = await resolveCommentPrincipal(null, session);
  let canComment = false;
  let canReact = false;
  let canEditDoc = false;
  if (principal) {
    const cap = await resolveCapability(doc, principal, canView(doc, viewtoken));
    canComment = cap.canComment;
    canReact = cap.canReact;
    canEditDoc = canEdit(cap.access);
  }

  const threadData = await allThreads(doc);
  const docReactions = threadData.doc_reactions ?? [];
  const anchoredReactions = threadData.anchored_reactions ?? [];
  const title = doc.title || doc.slug;
  const bookmarked = session ? await bookmarkExists(session.email, doc.id) : false;

  // Section deeplinks: the ordered heading list + stable fragment ids, derived
  // from the stored HTML. The shell forwards it to the overlay, which assigns the
  // ids to headings in document order and paints the gutter link icon.
  const sections = extractSections(doc.html);

  // Adaptive chrome (variant D): coarsely detect a DARK doc from the stored
  // HTML's unconditional html/body background so the shell renders themed at SSR —
  // CommentsShell uses it as the initial theme to avoid a light→dark flash before the
  // overlay's jh:theme refines it. Conservative — a bg dark only under
  // prefers-color-scheme is "unknown" → light.
  const serverTheme = detectServerTheme(doc.html);

  // Always the viewer shell: the light/dark toggle is a viewer feature that must be
  // available on every doc, including ones with no comments and viewers who can't
  // comment (the rail just stays collapsed). The doc still renders in the sandboxed
  // iframe; the overlay is injected so the toggle can repaint the document.
  const overlayQuery = rawQuery ? `${rawQuery}&overlay=1` : "?overlay=1";
  return (
    <CommentsShell
      slug={slug}
      title={title}
      rawSrc={`/d/${encodeURIComponent(slug)}/raw${overlayQuery}`}
      viewtoken={viewtoken}
      canComment={canComment}
      canReact={canReact}
      canEdit={canEditDoc}
      signedIn={session !== null}
      docId={doc.id}
      bookmarked={bookmarked}
      me={principal?.email ?? session?.email ?? null}
      initialThreads={threadData.threads}
      initialDocReactions={docReactions}
      initialAnchoredReactions={anchoredReactions}
      initialSections={sections}
      version={doc.version}
      initialTheme={serverTheme}
    />
  );
}
