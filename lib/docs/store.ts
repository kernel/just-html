import { getPool, query } from "@/lib/db";
import { generateSlug, generateViewToken } from "@/lib/docs/slug";
import { applyEdits, type Edit } from "@/lib/docs/edit-diff";
import { applyOps, type Op } from "@/lib/docs/doc-ops";
import { reanchorComments } from "@/lib/docs/reanchor";
import {
  MAX_DOCS_PER_USER,
  MAX_HTML_BYTES,
  MAX_STORAGE_BYTES_PER_USER,
  MAX_VERSIONS_PER_DOC,
  ORIGIN,
  VERSION_COALESCE_MS,
} from "@/lib/docs/config";

// Document persistence (birthday.md "Document API", "Editing", "Limits").
//
// VIEW TOKEN STORAGE — DELIBERATE: view_token is stored PLAINTEXT, not hashed.
// Every other secret in this system (API keys, claim tokens, user codes, login
// tokens, session tokens) is SHA-256 hashed at rest. The view token is the one
// exception, on purpose: the plan returns it to the owner on create AND on every
// GET / list of their docs ("→ {slug, url, view_token}"), which a hashed value
// cannot support. It is a capability-URL component (the "un-share" story is
// rotation, not revocation of a hash), not a credential equivalent: it grants
// read of one doc, nothing more, and is itself rotatable. So it lives in
// documents.view_token in the clear by design.

export type DocRow = {
  id: number;
  slug: string;
  owner_id: number;
  title: string | null;
  html: string;
  version: number;
  is_public: boolean;
  view_token: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type EditKind = "create" | "patch" | "rewrite";

/** The subset of a pg client the helpers below need (pool or transaction). */
type DbClient = { query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }> };

export function docUrl(slug: string): string {
  return `${ORIGIN}/d/${slug}`;
}

/** Public metadata shape returned to the owner (includes view_token + html). */
export function ownerView(doc: DocRow, includeHtml: boolean) {
  return {
    slug: doc.slug,
    url: docUrl(doc.slug),
    title: doc.title,
    version: doc.version,
    public: doc.is_public,
    view_token: doc.view_token,
    created_at: doc.created_at,
    updated_at: doc.updated_at,
    ...(includeHtml ? { html: doc.html } : {}),
  };
}

/**
 * Metadata shape returned to a non-owner grantee (editor/commenter/viewer).
 * Identical to ownerView MINUS view_token: the view token is an owner-only
 * capability (rotating it is the un-share story; an editor must not be able to
 * mint shareable links). `role` tells the grantee what they can do.
 */
export function granteeView(doc: DocRow, includeHtml: boolean, role: string) {
  return {
    slug: doc.slug,
    url: docUrl(doc.slug),
    title: doc.title,
    version: doc.version,
    public: doc.is_public,
    role,
    created_at: doc.created_at,
    updated_at: doc.updated_at,
    ...(includeHtml ? { html: doc.html } : {}),
  };
}

/**
 * List-item shape for GET /api/v1/docs (birthday.md "GET /api/v1/docs" row).
 * Every item carries `access`; owned items additionally carry `view_token`.
 * Shared items omit view_token (it's an owner-only capability — same rule as
 * granteeView). Used for scope=owned|shared|all so a single array can mix both.
 *
 * SHAPE NOTE: this carries `access` ("owner"|"editor"|"commenter"|"viewer"),
 * NOT `role`. granteeView (GET /api/v1/docs/:slug for a non-owner) carries
 * `role` instead. Both name the same concept; the listing uses `access` because
 * its rows can be owner OR grantee in one array (the plan's "GET /api/v1/docs"
 * row asks for `access`), while granteeView is always a non-owner so it uses
 * `role`. Two near-identical shapes coexist by design; don't conflate them.
 */
export function listItemView(
  doc: DocRow & { comment_count?: number | string },
  access: "owner" | "editor" | "commenter" | "viewer"
) {
  return {
    slug: doc.slug,
    url: docUrl(doc.slug),
    title: doc.title,
    access,
    version: doc.version,
    public: doc.is_public,
    // Live (non-deleted) comment + reply count (birthday.md B11: list items gain
    // comment_count; the /docs dashboard rows surface it too). Defaults to 0 when
    // the row didn't carry the aggregate.
    comment_count: Number(doc.comment_count ?? 0),
    created_at: doc.created_at,
    updated_at: doc.updated_at,
    // Owned docs carry the view_token (the owner's shareable capability); shared
    // docs do not (an editor/viewer must not be able to mint shareable links).
    ...(access === "owner" ? { view_token: doc.view_token } : {}),
  };
}

/** Byte length of a UTF-8 string (what the size limits are measured in). */
export function byteLen(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

export type QuotaError =
  | { kind: "doc_count"; limit: number; current: number }
  | { kind: "storage"; limit: number; current: number };

/**
 * Current per-user usage: non-deleted doc count and total stored bytes (current
 * html across live docs + retained version snapshots). Used for 403 quota checks.
 */
export async function userUsage(
  userId: number
): Promise<{ docCount: number; storageBytes: number }> {
  const { rows } = await query<{ doc_count: number; storage_bytes: number }>(
    `SELECT
       (SELECT count(*) FROM documents
          WHERE owner_id = $1 AND deleted_at IS NULL) AS doc_count,
       (
         COALESCE((SELECT sum(octet_length(html)) FROM documents
            WHERE owner_id = $1 AND deleted_at IS NULL), 0)
       + COALESCE((SELECT sum(octet_length(v.html)) FROM doc_versions v
            JOIN documents d ON d.id = v.doc_id
            WHERE d.owner_id = $1 AND d.deleted_at IS NULL), 0)
       ) AS storage_bytes`,
    [userId]
  );
  // count(*)/sum(...) are bigint (OID 20), parsed to JS numbers at the pg layer.
  return {
    docCount: rows[0]?.doc_count ?? 0,
    storageBytes: rows[0]?.storage_bytes ?? 0,
  };
}

/**
 * Create a document. Generates a unique slug (retry on collision), a plaintext
 * view token, inserts the documents row + the version-1 doc_versions snapshot in
 * one transaction. Enforces doc-count + storage quotas under no lock (counts are
 * monotonic enough; a tiny over-count race is acceptable for a soft cap).
 */
export async function createDoc(opts: {
  ownerId: number;
  html: string;
  title: string | null;
  isPublic: boolean;
}): Promise<{ doc: DocRow } | { quota: QuotaError }> {
  const usage = await userUsage(opts.ownerId);
  if (usage.docCount >= MAX_DOCS_PER_USER) {
    return { quota: { kind: "doc_count", limit: MAX_DOCS_PER_USER, current: usage.docCount } };
  }
  const incoming = byteLen(opts.html);
  if (usage.storageBytes + incoming > MAX_STORAGE_BYTES_PER_USER) {
    return {
      quota: { kind: "storage", limit: MAX_STORAGE_BYTES_PER_USER, current: usage.storageBytes },
    };
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // Retry slug generation on the unique violation (23505) a few times.
    let doc: DocRow | null = null;
    for (let attempt = 0; attempt < 6 && !doc; attempt++) {
      const slug = generateSlug();
      const viewToken = generateViewToken();
      try {
        const { rows } = await client.query(
          `INSERT INTO documents (slug, owner_id, title, html, version, is_public, view_token)
           VALUES ($1, $2, $3, $4, 1, $5, $6)
           RETURNING *`,
          [slug, opts.ownerId, opts.title, opts.html, opts.isPublic, viewToken]
        );
        doc = rows[0] as DocRow;
      } catch (e: unknown) {
        if (isUniqueViolation(e)) continue; // slug collision — try a new slug
        throw e;
      }
    }
    if (!doc) {
      await client.query("ROLLBACK");
      throw new Error("could not generate a unique slug after retries");
    }
    await client.query(
      `INSERT INTO doc_versions (doc_id, version, html, author_user_id, edit_kind)
       VALUES ($1, 1, $2, $3, 'create')`,
      [doc.id, opts.html, opts.ownerId]
    );
    await client.query("COMMIT");
    return { doc };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Storage-quota projection under a write lock — the ONE definition shared by
 * rewriteDoc and applyPatch. Both replace the locked doc's current html with a
 * new html AND add a new retained snapshot, so the projected per-owner usage is:
 *
 *   other docs' html + other docs' retained snapshots   (everything but THIS doc)
 *   + new current html (newHtmlBytes)
 *   + this doc's existing snapshot bytes + new snapshot (newHtmlBytes)
 *
 * We can't know exact pruned bytes cheaply pre-insert, so we bound the estimate
 * by the existing snapshot bytes + the new snapshot; the post-insert prune keeps
 * the row count capped, which keeps this honest over time.
 *
 * Returns the projected total (compare to MAX_STORAGE_BYTES_PER_USER) and the
 * `current` figure to surface on a quota error (other + this doc's *current* html
 * + this doc's snapshot bytes). Runs inside the caller's transaction/lock.
 */
async function projectStorage(
  client: { query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
  current: DocRow,
  newHtmlBytes: number
): Promise<{ projected: number; current: number }> {
  const { rows: usageRows } = await client.query(
    `SELECT
       COALESCE((SELECT sum(octet_length(html)) FROM documents
          WHERE owner_id = $1 AND deleted_at IS NULL AND id <> $2), 0)
     + COALESCE((SELECT sum(octet_length(v.html)) FROM doc_versions v
          JOIN documents d ON d.id = v.doc_id
          WHERE d.owner_id = $1 AND d.deleted_at IS NULL AND d.id <> $2), 0) AS other_bytes,
       COALESCE((SELECT sum(octet_length(v.html)) FROM doc_versions v
          WHERE v.doc_id = $2), 0) AS this_versions_bytes`,
    [current.owner_id, current.id]
  );
  // sum(...) is bigint (OID 20), parsed to a JS number at the pg layer.
  const u = usageRows[0] as { other_bytes: number; this_versions_bytes: number };
  const otherBytes = u?.other_bytes ?? 0;
  const thisVersionsBytes = u?.this_versions_bytes ?? 0;
  return {
    projected: otherBytes + newHtmlBytes + thisVersionsBytes + newHtmlBytes,
    current: otherBytes + byteLen(current.html) + thisVersionsBytes,
  };
}

/**
 * Apply a full-html rewrite (PATCH). Serializes via SELECT ... FOR UPDATE on the
 * documents row, bumps version, writes a full snapshot, prunes old versions past
 * the retention cap. Storage quota re-checked under the lock. Returns the updated
 * row, or a quota error.
 *
 * editKind is 'rewrite' for full-html PATCH (B3). The patch engine (B4) will call
 * a sibling with editKind='patch' + the patch payload.
 */
export async function rewriteDoc(opts: {
  doc: DocRow;
  html: string;
  authorUserId: number;
}): Promise<{ doc: DocRow } | { quota: QuotaError }> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows: lockRows } = await client.query(
      `SELECT * FROM documents WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [opts.doc.id]
    );
    const current = lockRows[0] as DocRow | undefined;
    if (!current) {
      await client.query("ROLLBACK");
      throw new Error("doc disappeared under write lock");
    }

    // Storage quota under the lock: replacing current.html with the new html, plus
    // a new retained snapshot (after pruning). Shared projection with applyPatch.
    const newHtmlBytes = byteLen(opts.html);
    const usage = await projectStorage(client, current, newHtmlBytes);
    if (usage.projected > MAX_STORAGE_BYTES_PER_USER) {
      await client.query("ROLLBACK");
      return {
        quota: { kind: "storage", limit: MAX_STORAGE_BYTES_PER_USER, current: usage.current },
      };
    }

    const nextVersion = current.version + 1;
    const { rows: updRows } = await client.query(
      `UPDATE documents SET html = $2, version = $3, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [current.id, opts.html, nextVersion]
    );
    await client.query(
      `INSERT INTO doc_versions (doc_id, version, html, author_user_id, edit_kind)
       VALUES ($1, $2, $3, $4, 'rewrite')`,
      [current.id, nextVersion, opts.html, opts.authorUserId]
    );
    await pruneVersions(client, current.id);
    // Re-anchor comments in the SAME transaction (birthday.md "How anchors
    // survive edits"). Full rewrite → tier 2 (quote re-find) only; no patch
    // ranges to offset-map. Best-effort: a re-anchor failure must not fail the
    // write (comments degrade to orphaned, the legible failure mode).
    try {
      await reanchorComments(client, current.id, current.html, opts.html, nextVersion);
    } catch {
      /* re-anchoring is best-effort; never block a doc write on it */
    }
    await client.query("COMMIT");
    return { doc: updRows[0] as DocRow };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Record a patch snapshot, folding it into the previous one when it continues
 * the same author's editing session (VERSION_COALESCE_MS).
 *
 * Inline editing writes far more often than an agent does — every blur, every
 * ⌘B — and one snapshot per keystroke burst would push a doc past
 * MAX_VERSIONS_PER_DOC in an afternoon and prune the history that makes those
 * writes recoverable. Coalescing keeps roughly one restorable point per five
 * minutes of continuous work.
 *
 * The document's version still increments on every write, so a concurrent writer
 * with a stale base_version is still detected. `created_at` is deliberately NOT
 * refreshed: the window is anchored to the start of the run, so a long session
 * yields a snapshot every five minutes rather than one at the very end.
 */
async function writePatchVersion(
  client: DbClient,
  docId: number,
  version: number,
  html: string,
  authorUserId: number,
  payload: unknown[]
): Promise<void> {
  const { rows } = await client.query(
    `SELECT id, version, edit_kind, author_user_id,
            (created_at > now() - ($2::bigint * interval '1 millisecond')) AS fresh
       FROM doc_versions WHERE doc_id = $1 ORDER BY version DESC LIMIT 1`,
    [docId, VERSION_COALESCE_MS]
  );
  const prev = rows[0] as
    | { id: number; version: number; edit_kind: EditKind; author_user_id: number | null; fresh: boolean }
    | undefined;

  const continues =
    prev &&
    prev.fresh &&
    prev.edit_kind === "patch" &&
    prev.author_user_id === authorUserId &&
    prev.version === version - 1;

  if (continues) {
    // The retained payload stays the full list of edits since the snapshot
    // before it, so `patch` still describes how this version was reached.
    await client.query(
      `UPDATE doc_versions
          SET version = $2, html = $3, patch = coalesce(patch, '[]'::jsonb) || $4::jsonb
        WHERE id = $1`,
      [prev.id, version, html, JSON.stringify(payload)]
    );
    return;
  }
  await client.query(
    `INSERT INTO doc_versions (doc_id, version, html, author_user_id, edit_kind, patch)
     VALUES ($1, $2, $3, $4, 'patch', $5)`,
    [docId, version, html, authorUserId, JSON.stringify(payload)]
  );
}

/**
 * Apply a patch (a list of {oldText,newText} edits) — birthday.md "Editing".
 *
 * Concurrency (two layers, both Postgres):
 *  1. Serialization — SELECT ... FOR UPDATE on the documents row inside the
 *     transaction. Concurrent writers queue; the txn is short.
 *  2. Staleness — if base_version is supplied and ≠ the locked current version,
 *     we abort with a `stale` result carrying the current version (→ 409). This
 *     is checked AFTER acquiring the lock so it reflects the truly-current row,
 *     not a value read before a competing writer committed.
 *
 * The deterministic engine (lib/docs/edit-diff.ts) applies the edits to the
 * locked html. On per-edit failure it throws EditApplyError, which we let
 * propagate to the HTTP layer for a structured 422 (it is NOT a quota/stale
 * outcome). On success: version bump + a 'patch' doc_versions snapshot whose
 * `patch` jsonb is the REQUESTED edits (snapshot html is the RESULT), then prune.
 *
 * Storage quota and the 2 MB per-doc cap are re-checked under the lock against
 * the produced html (a patch can grow a doc past the cap).
 */
export async function applyPatch(opts: {
  doc: DocRow;
  edits: Edit[];
  baseVersion?: number;
  authorUserId: number;
}): Promise<WriteResult> {
  return writeUnderLock({
    doc: opts.doc,
    baseVersion: opts.baseVersion,
    authorUserId: opts.authorUserId,
    // Apply the edits deterministically. EditApplyError propagates → 422.
    transform: (html) => ({ html: applyEdits(html, opts.edits) }),
    payload: opts.edits,
    // Patch write → tier 1 (offset map through these edits) then tier 2.
    reanchorEdits: opts.edits,
  });
}

/**
 * Apply structural operations (lib/docs/doc-ops.ts) — the write path behind the
 * viewer's formatting, block and list commands.
 *
 * Identical concurrency and quota handling to applyPatch. It differs in two
 * ways: OpApplyError propagates instead of EditApplyError, and the result
 * carries `focus`, the id newly created content ended up with, which the viewer
 * needs because every element id shifts when the document's length changes.
 *
 * Re-anchoring runs without an offset map: ops rewrite markup, so the tier-1
 * mapping (which walks {oldText,newText} through the TEXT projection) does not
 * describe them. Comments fall through to tier-2 quote re-finding, the same as
 * for a full rewrite.
 */
export async function applyDocOps(opts: {
  doc: DocRow;
  ops: Op[];
  baseVersion?: number;
  authorUserId: number;
}): Promise<WriteResult> {
  return writeUnderLock({
    doc: opts.doc,
    baseVersion: opts.baseVersion,
    authorUserId: opts.authorUserId,
    transform: (html) => applyOps(html, opts.ops),
    payload: opts.ops,
  });
}

export type WriteResult =
  | { doc: DocRow; focus?: number }
  | { quota: QuotaError }
  | { stale: { currentVersion: number } }
  | { tooLarge: { gotBytes: number } };

/**
 * The shared body of a versioned document write.
 *
 * Concurrency (two layers, both Postgres):
 *  1. Serialization — SELECT ... FOR UPDATE on the documents row inside the
 *     transaction. Concurrent writers queue; the txn is short.
 *  2. Staleness — if base_version is supplied and ≠ the locked current version,
 *     we abort with a `stale` result carrying the current version (→ 409). This
 *     is checked AFTER acquiring the lock so it reflects the truly-current row,
 *     not a value read before a competing writer committed.
 *
 * `transform` runs against the locked html and may throw a structured apply
 * error, which propagates to the HTTP layer for a 422 (it is NOT a quota/stale
 * outcome). On success: version bump + a 'patch' doc_versions snapshot whose
 * `patch` jsonb is the REQUESTED payload (snapshot html is the RESULT), then
 * prune. Storage quota and the 2 MB per-doc cap are re-checked under the lock
 * against the produced html, which a write can grow past the cap.
 */
async function writeUnderLock(opts: {
  doc: DocRow;
  baseVersion?: number;
  authorUserId: number;
  transform: (html: string) => { html: string; focus?: number };
  payload: unknown[];
  reanchorEdits?: Edit[];
}): Promise<WriteResult> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows: lockRows } = await client.query(
      `SELECT * FROM documents WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [opts.doc.id]
    );
    const current = lockRows[0] as DocRow | undefined;
    if (!current) {
      await client.query("ROLLBACK");
      throw new Error("doc disappeared under write lock");
    }

    // Staleness check under the lock (authoritative current version).
    if (opts.baseVersion !== undefined && opts.baseVersion !== current.version) {
      await client.query("ROLLBACK");
      return { stale: { currentVersion: current.version } };
    }

    let produced: { html: string; focus?: number };
    try {
      produced = opts.transform(current.html);
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    }
    const newHtml = produced.html;

    // 2 MB per-doc cap on the produced html.
    const newHtmlBytes = byteLen(newHtml);
    if (newHtmlBytes > MAX_HTML_BYTES) {
      await client.query("ROLLBACK");
      return { tooLarge: { gotBytes: newHtmlBytes } };
    }

    // Storage quota under the lock — same projection as rewriteDoc.
    const usage = await projectStorage(client, current, newHtmlBytes);
    if (usage.projected > MAX_STORAGE_BYTES_PER_USER) {
      await client.query("ROLLBACK");
      return {
        quota: { kind: "storage", limit: MAX_STORAGE_BYTES_PER_USER, current: usage.current },
      };
    }

    const nextVersion = current.version + 1;
    const { rows: updRows } = await client.query(
      `UPDATE documents SET html = $2, version = $3, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [current.id, newHtml, nextVersion]
    );
    await writePatchVersion(client, current.id, nextVersion, newHtml, opts.authorUserId, opts.payload);
    await pruneVersions(client, current.id);
    // Re-anchor comments in the SAME transaction. Best-effort.
    try {
      await reanchorComments(
        client,
        current.id,
        current.html,
        newHtml,
        nextVersion,
        opts.reanchorEdits
      );
    } catch {
      /* re-anchoring is best-effort; never block a doc write on it */
    }
    await client.query("COMMIT");
    return { doc: updRows[0] as DocRow, focus: produced.focus };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export type VersionRow = {
  id: number;
  doc_id: number;
  version: number;
  html: string;
  bytes: number;
  author_user_id: number | null;
  edit_kind: EditKind;
  patch: unknown;
  created_at: string;
};

/** Shape returned for a version (metadata only unless includeHtml). */
export function versionView(v: VersionRow, includeHtml: boolean) {
  return {
    version: v.version,
    edit_kind: v.edit_kind,
    patch: v.edit_kind === "patch" ? v.patch : undefined,
    // bigint id (OID 20) is parsed to a JS number at the pg layer (lib/db.ts), so
    // it serializes as a JSON number API-wide (matches Grant.id and the VersionMeta
    // schema in spec.yaml). bytes is octet_length (int4), already a number.
    author_user_id: v.author_user_id,
    created_at: v.created_at,
    bytes: Number(v.bytes),
    ...(includeHtml ? { html: v.html } : {}),
  };
}

/** List retained version snapshots for a doc, newest first (metadata + byte size, no html). */
export async function listVersions(docId: number): Promise<VersionRow[]> {
  const { rows } = await query<VersionRow>(
    `SELECT id, doc_id, version, '' AS html, octet_length(html) AS bytes,
            author_user_id, edit_kind, patch, created_at
     FROM doc_versions WHERE doc_id = $1 ORDER BY version DESC`,
    [docId]
  );
  return rows;
}

/** Fetch one version's full snapshot, or null if not retained. */
export async function findVersion(docId: number, version: number): Promise<VersionRow | null> {
  const { rows } = await query<VersionRow>(
    `SELECT id, doc_id, version, html, octet_length(html) AS bytes,
            author_user_id, edit_kind, patch, created_at
     FROM doc_versions WHERE doc_id = $1 AND version = $2`,
    [docId, version]
  );
  return rows[0] ?? null;
}

/** All retained versions WITH html, oldest first — for the history diff page. */
export async function listVersionsWithHtml(docId: number): Promise<VersionRow[]> {
  const { rows } = await query<VersionRow>(
    `SELECT id, doc_id, version, html, octet_length(html) AS bytes,
            author_user_id, edit_kind, patch, created_at
     FROM doc_versions WHERE doc_id = $1 ORDER BY version ASC`,
    [docId]
  );
  return rows;
}

/**
 * Prune retained version snapshots beyond MAX_VERSIONS_PER_DOC, oldest first.
 * Runs inside the caller's transaction. Keeps the newest N versions.
 */
async function pruneVersions(client: DbClient, docId: number): Promise<void> {
  await client.query(
    `DELETE FROM doc_versions
     WHERE doc_id = $1
       AND version <= (
         SELECT version FROM doc_versions
         WHERE doc_id = $1
         ORDER BY version DESC
         OFFSET $2 LIMIT 1
       )`,
    [docId, MAX_VERSIONS_PER_DOC]
  );
}

/** Update metadata only (title and/or public flag) — no version bump. */
export async function updateMeta(opts: {
  docId: number;
  title?: string | null;
  isPublic?: boolean;
}): Promise<DocRow> {
  const sets: string[] = [];
  const params: unknown[] = [opts.docId];
  if (opts.title !== undefined) {
    params.push(opts.title);
    sets.push(`title = $${params.length}`);
  }
  if (opts.isPublic !== undefined) {
    params.push(opts.isPublic);
    sets.push(`is_public = $${params.length}`);
  }
  sets.push("updated_at = now()");
  const { rows } = await query<DocRow>(
    `UPDATE documents SET ${sets.join(", ")} WHERE id = $1 RETURNING *`,
    params
  );
  return rows[0];
}

/** Rotate the view token (the "un-share" action). Returns the new plaintext token. */
export async function rotateViewToken(docId: number): Promise<DocRow> {
  const { rows } = await query<DocRow>(
    `UPDATE documents SET view_token = $2, updated_at = now()
     WHERE id = $1 RETURNING *`,
    [docId, generateViewToken()]
  );
  return rows[0];
}

/** Soft-delete (sets deleted_at). Idempotent. */
export async function softDelete(docId: number): Promise<void> {
  await query(`UPDATE documents SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`, [
    docId,
  ]);
}

/** Fetch a live (non-deleted) doc by slug. */
export async function findBySlug(slug: string): Promise<DocRow | null> {
  const { rows } = await query<DocRow>(
    `SELECT * FROM documents WHERE slug = $1 AND deleted_at IS NULL`,
    [slug]
  );
  return rows[0] ?? null;
}

/**
 * A doc row carrying a live comment count — for the listing surfaces (the /docs
 * dashboard rows and GET /api/v1/docs items, birthday.md B11). comment_count is
 * the number of non-deleted comments + replies on the doc.
 */
export type DocListRow = DocRow & { comment_count: number };

/** Correlated live-comment count, reused by both listing queries. */
const COMMENT_COUNT_SUBQUERY = `
  (SELECT count(*) FROM comments c
     WHERE c.doc_id = d.id AND c.deleted_at IS NULL)::int AS comment_count`;

/** List a user's live docs, newest first (with comment_count). */
export async function listDocs(ownerId: number, limit: number): Promise<DocListRow[]> {
  const { rows } = await query<DocListRow>(
    `SELECT d.*, ${COMMENT_COUNT_SUBQUERY}
     FROM documents d
     WHERE d.owner_id = $1 AND d.deleted_at IS NULL
     ORDER BY d.created_at DESC LIMIT $2`,
    [ownerId, limit]
  );
  return rows;
}

/**
 * A doc shared with an email (via an email grant or its domain grant), with the
 * grantee's resolved access role. Used by GET /api/v1/docs?scope=shared|all and
 * the /docs web page. The role here reflects the precedence ladder (email grant
 * beats domain grant for the same email); see the SQL below.
 */
export type SharedDocRow = DocRow & {
  access: "editor" | "commenter" | "viewer";
  comment_count: number;
};

export type BookmarkDocRow = DocRow & {
  bookmarked_at: string;
  // The view token the doc was bookmarked through (NULL for owner/grant/public
  // access). Aliased off `view_token` so it does not clobber the doc's own
  // current `view_token` from `d.*`; access is re-checked against this.
  bookmark_token: string | null;
  // The doc's title captured at bookmark time — shown for a revoked doc (the
  // viewer can no longer see the doc's current `title`). Aliased so it does not
  // clobber `d.title`.
  bookmark_title: string | null;
};

/**
 * List docs shared with `email` (an email grant for that exact address OR a
 * domain grant for its email-domain), EXCLUDING docs the email owns. One query.
 *
 * Precedence: an explicit email grant beats a domain grant for the same email
 * (birthday.md "explicit email grant beats domain grant"). The grants table can
 * carry both an 'email' row and a 'domain' row that match this caller; we pick
 * the email-grant role when present via DISTINCT ON ordered by grantee_type
 * DESC ('email' > 'domain' lexically, so 'email' is taken first per doc).
 *
 * Newest-updated first. `excludeOwnerId` is the caller's user_id when they have
 * an account (so docs they own are not double-listed in the shared section). For
 * an account-less grantee it is null and the exclusion is skipped: an owner
 * always has an account (you cannot own a doc without registering), so an
 * account-less caller can never own any of the candidate rows — there is nothing
 * to exclude. (A previous version had an extra `owner_id <> (SELECT id FROM users
 * WHERE email = $1)` anti-join here; for an account-less email that subquery is
 * NULL, making `owner_id <> NULL` NULL — which filtered out EVERY row and left
 * account-less grantees with an empty shared section. Removed.)
 */
export async function listSharedDocs(
  email: string,
  emailDomain: string,
  excludeOwnerId: number | null,
  limit: number
): Promise<SharedDocRow[]> {
  const lower = email.toLowerCase();
  const { rows } = await query<SharedDocRow>(
    `SELECT d.*, g.role AS access, ${COMMENT_COUNT_SUBQUERY}
     FROM (
       SELECT DISTINCT ON (doc_id) doc_id, role
       FROM doc_grants
       WHERE (grantee_type = 'email'  AND grantee = $1)
          OR (grantee_type = 'domain' AND grantee = $2)
       ORDER BY doc_id, grantee_type DESC  -- 'email' > 'domain': email grant wins
     ) g
     JOIN documents d ON d.id = g.doc_id
     WHERE d.deleted_at IS NULL
       AND ($3::int IS NULL OR d.owner_id <> $3)
     ORDER BY d.updated_at DESC
     LIMIT $4`,
    [lower, emailDomain, excludeOwnerId, limit]
  );
  return rows;
}

/** True if a bookmark already exists for this email + doc. */
export async function bookmarkExists(bookmarkerEmail: string, docId: number): Promise<boolean> {
  const { rows } = await query<{ n: number }>(
    `SELECT count(*) AS n FROM bookmarks
     WHERE bookmarker_email = $1 AND doc_id = $2`,
    [bookmarkerEmail.toLowerCase(), docId]
  );
  return (rows[0]?.n ?? 0) > 0;
}

/**
 * Idempotently save a bookmark for this email + doc, recording the view token
 * it was reached through (NULL for owner/grant/public access). Re-saving keeps
 * an existing token when the new save carries none, so a later grant-based save
 * does not strip a token the bookmark still needs.
 */
export async function saveBookmark(
  bookmarkerEmail: string,
  docId: number,
  viewToken: string | null,
  title: string | null
): Promise<void> {
  await query(
    `INSERT INTO bookmarks (bookmarker_email, doc_id, view_token, doc_title)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (bookmarker_email, doc_id)
     DO UPDATE SET
       view_token = COALESCE(EXCLUDED.view_token, bookmarks.view_token),
       doc_title = EXCLUDED.doc_title`,
    [bookmarkerEmail.toLowerCase(), docId, viewToken, title]
  );
}

/** Remove a bookmark. Keyed by doc id so a revoked/deleted doc can still be
 *  dropped from the list (its slug is no longer resolvable). */
export async function removeBookmark(bookmarkerEmail: string, docId: number): Promise<void> {
  await query(`DELETE FROM bookmarks WHERE bookmarker_email = $1 AND doc_id = $2`, [
    bookmarkerEmail.toLowerCase(),
    docId,
  ]);
}

/**
 * Remove a bookmark by slug, resolving the doc id even when the doc is
 * soft-deleted (findBySlug skips deleted docs, so the slug-keyed API DELETE
 * routes through this to still drop a bookmark for a revoked/deleted doc).
 * Idempotent: removes zero rows when there is no such bookmark.
 */
export async function removeBookmarkBySlug(bookmarkerEmail: string, slug: string): Promise<void> {
  await query(
    `DELETE FROM bookmarks b
       USING documents d
      WHERE b.doc_id = d.id
        AND b.bookmarker_email = $1
        AND d.slug = $2`,
    [bookmarkerEmail.toLowerCase(), slug]
  );
}

/**
 * List a user's bookmarks, newest first, with the live document row and the
 * token the doc was bookmarked through. `opts.scope` filters in SQL so `limit`
 * applies AFTER the owned/shared split (owned = docs the caller owns) — a scoped
 * request never underfills because out-of-scope rows ate the limit. The owner
 * comparison needs the caller's account id; without one (an account-less
 * grantee) nothing is owned, so `owned` is empty and `shared` is everything.
 */
export async function listBookmarks(
  bookmarkerEmail: string,
  limit: number,
  opts?: { scope?: "owned" | "shared" | "all"; ownerId?: number | null }
): Promise<BookmarkDocRow[]> {
  const scope = opts?.scope ?? "all";
  const ownerId = opts?.ownerId ?? null;
  const params: (string | number)[] = [bookmarkerEmail.toLowerCase(), limit];

  let scopeClause = "";
  if (scope === "owned") {
    if (ownerId == null) return []; // an account-less caller owns nothing
    params.push(ownerId);
    scopeClause = `AND d.owner_id = $${params.length}`;
  } else if (scope === "shared" && ownerId != null) {
    params.push(ownerId);
    scopeClause = `AND d.owner_id <> $${params.length}`;
  }

  const { rows } = await query<BookmarkDocRow>(
    `SELECT d.*, b.created_at AS bookmarked_at, b.view_token AS bookmark_token,
            b.doc_title AS bookmark_title
     FROM bookmarks b
     JOIN documents d ON d.id = b.doc_id
     WHERE b.bookmarker_email = $1 ${scopeClause}
     ORDER BY b.created_at DESC, b.id DESC
     LIMIT $2`,
    params
  );
  return rows;
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "23505";
}
