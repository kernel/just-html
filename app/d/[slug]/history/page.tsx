import { notFound } from "next/navigation";
import { findBySlug, listVersionsWithHtml } from "@/lib/docs/store";
import { canView } from "@/lib/docs/access";
import { unifiedPatch } from "@/lib/docs/diff";
import HistoryClient, { type VersionMeta } from "./HistoryClient";

export const dynamic = "force-dynamic";

// GET /d/:slug/history — version list + diffs (birthday.md "History"). React
// surface #2. ACCESS RULES ARE IDENTICAL TO THE DOC (canView): public docs are
// open; private docs require a matching ?viewtoken=. A missing slug and an
// unauthorized private doc render the same "private or does not exist" notice
// (no existence oracle), matching /d/:slug and /d/:slug/raw.
//
// Diffs are computed here, server-side, from the FULL snapshots in doc_versions
// (oldest→newest), then handed to the client component as unified-patch strings.
// We never ship the raw doc html into our origin's executable scope: the client
// renders these patches as code via @pierre/diffs, not as live HTML.

type Props = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ [k: string]: string | string[] | undefined }>;
};

export default async function HistoryPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const sp = await searchParams;
  const rawToken = sp.viewtoken;
  const viewtoken = Array.isArray(rawToken) ? (rawToken[0] ?? null) : (rawToken ?? null);

  const doc = await findBySlug(slug);
  if (!doc || !canView(doc, viewtoken)) {
    // No existence oracle: a missing slug and an unauthorized private doc both
    // 404 with the same notice (rendered by ./not-found.tsx), matching /d/:slug.
    notFound();
  }

  const snapshots = await listVersionsWithHtml(doc.id); // oldest → newest

  // Compute the unified patch from each version to the one before it. The oldest
  // retained snapshot has no predecessor (it may be the create, or — if older
  // versions were pruned past the 100-version cap — the oldest surviving one), so
  // it carries no patch and is shown as a non-diffable list entry.
  const metas: VersionMeta[] = [];
  for (let i = 0; i < snapshots.length; i++) {
    const v = snapshots[i];
    const prev = i > 0 ? snapshots[i - 1] : undefined;
    metas.push({
      version: v.version,
      edit_kind: v.edit_kind,
      created_at: v.created_at,
      bytes: Number(v.bytes),
      patch: prev ? unifiedPatch(prev.html, v.html, prev.version, v.version) : undefined,
    });
  }
  metas.reverse(); // newest first for display

  const title = doc.title || doc.slug;

  return (
    <main
      style={{
        margin: "0 auto",
        maxWidth: 1100,
        padding: "1.5rem 1.25rem 4rem",
        fontFamily: `ui-monospace, "SF Mono", Menlo, Consolas, "Courier New", monospace`,
      }}
    >
      <HistoryClient
        slug={doc.slug}
        title={title}
        currentVersion={doc.version}
        versions={metas}
      />
    </main>
  );
}
