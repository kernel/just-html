import { getPool, query } from "@/lib/db";
import { generateSlug, generateViewToken } from "@/lib/docs/slug";
import {
  MAX_DOCS_PER_USER,
  MAX_STORAGE_BYTES_PER_USER,
  MAX_VERSIONS_PER_DOC,
  ORIGIN,
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
  const { rows } = await query<{ doc_count: string; storage_bytes: string }>(
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
  return {
    docCount: Number(rows[0]?.doc_count ?? 0),
    storageBytes: Number(rows[0]?.storage_bytes ?? 0),
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
    // a new retained snapshot (after pruning). Re-derive owner usage minus this
    // doc's current contribution, add the projected new contribution.
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
    const otherBytes = Number(usageRows[0]?.other_bytes ?? 0);
    const newHtmlBytes = byteLen(opts.html);
    // Versions retained for this doc after adding the new snapshot and pruning to
    // MAX_VERSIONS_PER_DOC. We can't know exact pruned bytes cheaply pre-insert, so
    // bound the estimate by current snapshot bytes + new snapshot; the post-insert
    // prune keeps the row count capped which keeps this honest over time.
    const thisVersionsBytes = Number(usageRows[0]?.this_versions_bytes ?? 0);
    const projected = otherBytes + newHtmlBytes /* new current html */ +
      thisVersionsBytes + newHtmlBytes /* new snapshot */;
    if (projected > MAX_STORAGE_BYTES_PER_USER) {
      await client.query("ROLLBACK");
      return {
        quota: {
          kind: "storage",
          limit: MAX_STORAGE_BYTES_PER_USER,
          current: otherBytes + Number(byteLen(current.html)) + thisVersionsBytes,
        },
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
 * Prune retained version snapshots beyond MAX_VERSIONS_PER_DOC, oldest first.
 * Runs inside the caller's transaction. Keeps the newest N versions.
 */
async function pruneVersions(
  client: { query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
  docId: number
): Promise<void> {
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

/** List a user's live docs, newest first. */
export async function listDocs(ownerId: number, limit: number): Promise<DocRow[]> {
  const { rows } = await query<DocRow>(
    `SELECT * FROM documents WHERE owner_id = $1 AND deleted_at IS NULL
     ORDER BY created_at DESC LIMIT $2`,
    [ownerId, limit]
  );
  return rows;
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "23505";
}
