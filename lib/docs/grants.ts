import { getPool, query } from "@/lib/db";
import type { DocRow } from "@/lib/docs/store";

// Sharing / permissions model (birthday.md "Permissions model"). Grants target
// either an email or a verified email-domain and carry a role. Resolution order
// for an authenticated principal acting on a doc, most→least privileged:
//
//   owner  >  email grant  >  domain grant  >  view token  >  public
//
// (View-token / public access is the *viewer-route* path, not the API-key path;
// the API enforcement here covers owner + email/domain grants. The grants API
// itself is owner-only.)

export type GrantRole = "editor" | "commenter" | "viewer";
export const GRANT_ROLES: GrantRole[] = ["editor", "commenter", "viewer"];

export type GranteeType = "email" | "domain";

export type GrantRow = {
  id: number;
  doc_id: number;
  grantee_type: GranteeType;
  grantee: string;
  role: GrantRole;
  created_by: number | null;
  created_at: string;
};

// Max grants per doc (birthday.md "Limits": Grants per doc = 50).
export const MAX_GRANTS_PER_DOC = 50;

// Consumer email providers. A domain grant against one of these is "granting the
// world" (anyone can get an @gmail.com address), so the plan rejects them and
// points the owner at is_public or the view token instead. List per birthday.md
// "Permissions model" (gmail/googlemail/outlook/hotmail/live/yahoo/icloud/me/
// aol/proton/protonmail/mail/gmx) plus a reasonable widening of common free
// providers and their regional yahoo/outlook TLD variants.
export const CONSUMER_EMAIL_DOMAINS = new Set<string>([
  // explicitly named in birthday.md
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "mail.com",
  "gmx.com",
  // reasonable others (common free/consumer mailbox providers)
  "mac.com",
  "msn.com",
  "ymail.com",
  "rocketmail.com",
  "pm.me",
  "proton.com",
  "gmx.net",
  "gmx.de",
  "yandex.com",
  "yandex.ru",
  "zoho.com",
  "fastmail.com",
  "fastmail.fm",
  "hey.com",
  "tutanota.com",
  "tuta.com",
  "tutanota.de",
  "hotmail.co.uk",
  "hotmail.fr",
  "live.co.uk",
  "outlook.co.uk",
  "yahoo.co.uk",
  "yahoo.ca",
  "yahoo.com.au",
  "yahoo.fr",
  "yahoo.de",
  "yahoo.es",
  "yahoo.it",
  "yahoo.co.in",
  "yahoo.co.jp",
  "qq.com",
  "163.com",
  "126.com",
  "naver.com",
  "daum.net",
  "hanmail.net",
  "web.de",
  "t-online.de",
  "freenet.de",
  "comcast.net",
  "verizon.net",
  "att.net",
  "sbcglobal.net",
  "cox.net",
  "bellsouth.net",
  "btinternet.com",
  "orange.fr",
  "wanadoo.fr",
  "free.fr",
  "laposte.net",
  "libero.it",
  "virgilio.it",
  "seznam.cz",
  "o2.pl",
  "wp.pl",
  "interia.pl",
  "mail.ru",
  "bk.ru",
  "inbox.ru",
  "list.ru",
  "rambler.ru",
  "ukr.net",
  "rediffmail.com",
  "googleemail.com",
]);

export function isConsumerDomain(domain: string): boolean {
  return CONSUMER_EMAIL_DOMAINS.has(domain.toLowerCase());
}

// Domain shape: at least one dot, labels of [a-z0-9-] not starting/ending in a
// hyphen. Deliberately conservative — a grant domain is matched against a
// verified login email's domain, so it must look like a real registrable domain.
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
// Email shape mirrors the auth-flow validator (reference's classifyLoginHint).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidDomain(s: string): boolean {
  return DOMAIN_RE.test(s);
}

export function isValidEmail(s: string): boolean {
  return EMAIL_RE.test(s);
}

/** Lowercased domain part of an email (after the last '@'). */
export function emailDomain(email: string): string {
  const at = email.lastIndexOf("@");
  return at === -1 ? "" : email.slice(at + 1).toLowerCase();
}

export function grantView(g: GrantRow) {
  return {
    // pg returns bigint columns as strings; coerce to a JSON number so the
    // serialized id matches the OpenAPI spec (Grant.id: integer) and DELETE's
    // integer grant_id. (spec.yaml + DELETE /grants/:id are the source of truth.)
    id: Number(g.id),
    grantee_type: g.grantee_type,
    grantee: g.grantee,
    role: g.role,
    created_at: g.created_at,
  };
}

/** List a doc's grants, newest first. */
export async function listGrants(docId: number): Promise<GrantRow[]> {
  const { rows } = await query<GrantRow>(
    `SELECT id, doc_id, grantee_type, grantee::text AS grantee, role, created_by, created_at
     FROM doc_grants WHERE doc_id = $1 ORDER BY created_at DESC, id DESC`,
    [docId]
  );
  return rows;
}

export async function countGrants(docId: number): Promise<number> {
  const { rows } = await query<{ n: string }>(
    `SELECT count(*) AS n FROM doc_grants WHERE doc_id = $1`,
    [docId]
  );
  return Number(rows[0]?.n ?? 0);
}

export type CreateGrantResult =
  | { grant: GrantRow }
  | { error: "limit" }
  | { error: "exists"; grant: GrantRow };

/**
 * Create (or detect a duplicate of) a grant. Enforces the 50-per-doc limit
 * inside the same transaction as the insert so the count can't be raced past
 * the cap. The (doc_id, grantee_type, grantee) unique index makes a re-grant of
 * the same target idempotent-ish: we surface the existing row rather than
 * erroring opaquely, after first checking whether the role changed.
 */
export async function createGrant(opts: {
  docId: number;
  granteeType: GranteeType;
  grantee: string; // already normalized (lowercased)
  role: GrantRole;
  createdBy: number;
}): Promise<CreateGrantResult> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    // Existing grant for this exact target? (citext index → case-insensitive.)
    const { rows: existingRows } = await client.query(
      `SELECT id, doc_id, grantee_type, grantee::text AS grantee, role, created_by, created_at
       FROM doc_grants
       WHERE doc_id = $1 AND grantee_type = $2 AND grantee = $3
       FOR UPDATE`,
      [opts.docId, opts.granteeType, opts.grantee]
    );
    const existing = existingRows[0] as GrantRow | undefined;
    if (existing) {
      if (existing.role === opts.role) {
        await client.query("ROLLBACK");
        return { error: "exists", grant: existing };
      }
      // Role change on an existing target — update in place (idempotent share).
      const { rows: updRows } = await client.query(
        `UPDATE doc_grants SET role = $2
         WHERE id = $1
         RETURNING id, doc_id, grantee_type, grantee::text AS grantee, role, created_by, created_at`,
        [existing.id, opts.role]
      );
      await client.query("COMMIT");
      return { grant: updRows[0] as GrantRow };
    }

    // Enforce the per-doc cap under the transaction.
    const { rows: countRows } = await client.query(
      `SELECT count(*) AS n FROM doc_grants WHERE doc_id = $1`,
      [opts.docId]
    );
    if (Number((countRows[0] as { n: string }).n) >= MAX_GRANTS_PER_DOC) {
      await client.query("ROLLBACK");
      return { error: "limit" };
    }

    const { rows: insRows } = await client.query(
      `INSERT INTO doc_grants (doc_id, grantee_type, grantee, role, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, doc_id, grantee_type, grantee::text AS grantee, role, created_by, created_at`,
      [opts.docId, opts.granteeType, opts.grantee, opts.role, opts.createdBy]
    );
    await client.query("COMMIT");
    return { grant: insRows[0] as GrantRow };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Delete a grant by id, scoped to the doc. Returns true if a row was removed. */
export async function deleteGrant(docId: number, grantId: number): Promise<boolean> {
  const { rowCount } = await query(
    `DELETE FROM doc_grants WHERE id = $1 AND doc_id = $2`,
    [grantId, docId]
  );
  return rowCount > 0;
}

export type DocAccess =
  | { kind: "owner"; role: null }
  | { kind: "email_grant"; role: GrantRole }
  | { kind: "domain_grant"; role: GrantRole }
  | { kind: "none"; role: null };

/**
 * Resolve an API principal's access to a doc, per the permissions ladder:
 * owner > email grant > domain grant. (View token + public are the viewer-route
 * path, handled separately in lib/docs/access.ts — an API-key holder always acts
 * as their authenticated email, never as an anonymous token-bearer.)
 *
 * Email grant strictly beats a domain grant for the same email (explicit beats
 * implicit). A `viewer`/`commenter` email grant does NOT get silently upgraded
 * by a broader `editor` domain grant — the explicit email grant is the operative
 * one. (Plan: "explicit email grant beats domain grant".)
 */
export async function resolveAccess(doc: DocRow, principalEmail: string, principalUserId: number): Promise<DocAccess> {
  if (doc.owner_id === principalUserId) return { kind: "owner", role: null };

  const email = principalEmail.toLowerCase();
  const domain = emailDomain(email);

  const { rows } = await query<{ grantee_type: GranteeType; role: GrantRole }>(
    `SELECT grantee_type, role FROM doc_grants
     WHERE doc_id = $1
       AND (
         (grantee_type = 'email'  AND grantee = $2)
         OR (grantee_type = 'domain' AND grantee = $3)
       )`,
    [doc.id, email, domain]
  );

  let emailRole: GrantRole | null = null;
  let domainRole: GrantRole | null = null;
  for (const r of rows) {
    if (r.grantee_type === "email") emailRole = r.role;
    else if (r.grantee_type === "domain") domainRole = r.role;
  }

  if (emailRole) return { kind: "email_grant", role: emailRole };
  if (domainRole) return { kind: "domain_grant", role: domainRole };
  return { kind: "none", role: null };
}

/** True if the resolved access can read the doc (owner or any grant). */
export function canRead(access: DocAccess): boolean {
  return access.kind !== "none";
}

/** True if the resolved access can edit (GET/PATCH//edits) — owner or editor grant. */
export function canEdit(access: DocAccess): boolean {
  if (access.kind === "owner") return true;
  return access.role === "editor";
}

/** Label for the granteeView `role` field. */
export function accessRoleLabel(access: DocAccess): string {
  return access.kind === "owner" ? "owner" : (access.role ?? "none");
}
