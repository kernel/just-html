import { describe, it, expect, beforeEach, vi } from "vitest";
import type { DocRow } from "@/lib/docs/store";
import type { CommentRow } from "@/lib/docs/comments";

// Unit tests for the comment-notification orchestrator. The DB, the email send,
// the rate-limit check, and the audit log are all mocked, so these pin the
// recipient model, the per-recipient cap, the token/idempotency shape, the
// snippet truncation, the send-failure rollback, the footer flavor, and — most
// importantly — that this path NEVER touches EMAIL_SEND_LIMITS (comment volume
// must not burn the owner's login/share email budget).

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  sendCommentEmail: vi.fn(),
  checkLimits: vi.fn(),
  audit: vi.fn(),
  EMAIL_SEND_LIMITS: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ query: mocks.query }));
vi.mock("@/lib/auth/email", () => ({ sendCommentEmail: mocks.sendCommentEmail }));
vi.mock("@/lib/auth/ratelimit", () => ({
  checkLimits: mocks.checkLimits,
  // Spy: if the path ever imports/calls this, the assertion below catches it.
  EMAIL_SEND_LIMITS: mocks.EMAIL_SEND_LIMITS,
}));
vi.mock("@/lib/auth/audit", () => ({ audit: mocks.audit }));

import { sendCommentNotification } from "@/lib/docs/comment-notify";
import { SHARE_TOKEN_TTL_S } from "@/lib/auth/config";

// ---------------------------------------------------------------------------
// Fixtures + a SQL-routing query mock.
// ---------------------------------------------------------------------------

const OWNER_ID = 1;
const ALICE_ID = 2; // a thread participant
const BOB_ID = 3; // another participant / sometimes the author

function makeDoc(over: Partial<DocRow> = {}): DocRow {
  return {
    id: 100,
    slug: "fierce-tiger-12345",
    owner_id: OWNER_ID,
    title: "Q3 launch plan",
    html: "<p>hello</p>",
    version: 1,
    is_public: false,
    view_token: "vt",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    deleted_at: null,
    ...over,
  };
}

function makeComment(over: Partial<CommentRow> = {}): CommentRow {
  return {
    id: 88421,
    doc_id: 100,
    author_user_id: ALICE_ID,
    author_email: "alice@co.com",
    parent_id: null,
    anchor: null,
    anchored_version: null,
    orphaned: false,
    body: "Can we name the retention cap here?",
    created_at: "2026-01-02T00:00:00Z",
    edited_at: null,
    resolved_at: null,
    resolved_by_user_id: null,
    deleted_at: null,
    ...over,
  };
}

type Rows = { rows: unknown[]; rowCount?: number };

/**
 * Route the orchestrator's queries by SQL shape. `opts` supplies the rows each
 * logical query returns; the token INSERT auto-assigns ids and records the
 * params so tests can assert on them.
 *
 * Reply participants are filtered through resolveAccess (a doc_grants lookup) on
 * a private doc, so `grantedEmails` lists the participant emails that still hold
 * a live grant (defaults to everyone returned by the participant query). A
 * public doc short-circuits resolveAccess, so that lookup never fires there.
 */
function routeQuery(opts: {
  ownerRows?: Array<{ email: string }>;
  participantRows?: Array<{ id: number; email: string }>;
  parentRows?: Array<{ email: string | null; body: string }>;
  grantedEmails?: string[];
  onTokenInsert?: (params: unknown[]) => void;
  onTokenDelete?: (params: unknown[]) => void;
}): void {
  // Default: every participant still has access (keeps the access filter a no-op
  // for tests that aren't exercising revocation).
  const granted =
    opts.grantedEmails ?? (opts.participantRows ?? []).map((p) => p.email.toLowerCase());
  let nextTokenId = 9000;
  mocks.query.mockImplementation(async (sql: string, params?: unknown[]): Promise<Rows> => {
    if (sql.includes("FROM users WHERE id =")) {
      return { rows: opts.ownerRows ?? [{ email: "owner@co.com" }] };
    }
    if (sql.includes("SELECT DISTINCT u.id, u.email")) {
      return { rows: opts.participantRows ?? [] };
    }
    if (sql.includes("FROM doc_grants")) {
      // resolveAccess: $2 is the lowercased principal email. Return a grant row
      // iff this email is in the granted set.
      const email = String(params?.[1] ?? "").toLowerCase();
      return { rows: granted.includes(email) ? [{ grantee_type: "email", role: "commenter" }] : [] };
    }
    if (sql.includes("SELECT u.email, c.body")) {
      return { rows: opts.parentRows ?? [] };
    }
    if (sql.includes("INSERT INTO login_tokens")) {
      opts.onTokenInsert?.(params ?? []);
      return { rows: [{ id: nextTokenId++ }] };
    }
    if (sql.includes("DELETE FROM login_tokens")) {
      opts.onTokenDelete?.(params ?? []);
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected SQL in test: ${sql}`);
  });
}

const req = new Request("https://justhtml.sh/api/v1/docs/fierce-tiger-12345/comments");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.checkLimits.mockResolvedValue(null); // pass the cap by default
  mocks.sendCommentEmail.mockResolvedValue("re_123"); // succeed by default
});

// ---------------------------------------------------------------------------
// Recipient model.
// ---------------------------------------------------------------------------

describe("recipient model", () => {
  it("self-suppression: a top-level comment by the owner notifies no one", async () => {
    routeQuery({ ownerRows: [{ email: "owner@co.com" }] });
    const doc = makeDoc();
    const comment = makeComment({ author_user_id: OWNER_ID, author_email: "owner@co.com" });

    const res = await sendCommentNotification({ req, doc, comment });

    expect(res).toEqual({ notified: 0, recipients: 0 });
    expect(mocks.sendCommentEmail).not.toHaveBeenCalled();
  });

  it("top-level comment by a non-owner notifies the OWNER only", async () => {
    routeQuery({ ownerRows: [{ email: "owner@co.com" }] });
    const doc = makeDoc();
    const comment = makeComment({ author_user_id: ALICE_ID, author_email: "alice@co.com" });

    const res = await sendCommentNotification({ req, doc, comment });

    expect(res.notified).toBe(1);
    expect(mocks.sendCommentEmail).toHaveBeenCalledTimes(1);
    expect(mocks.sendCommentEmail.mock.calls[0][0]).toMatchObject({
      to: "owner@co.com",
      isReply: false,
      isOwnerRecipient: true,
    });
  });

  it("no-owner-email: owner row missing → owner is dropped (top-level → nobody)", async () => {
    routeQuery({ ownerRows: [] });
    const doc = makeDoc();
    const comment = makeComment({ author_user_id: ALICE_ID });

    const res = await sendCommentNotification({ req, doc, comment });

    expect(res).toEqual({ notified: 0, recipients: 0 });
    expect(mocks.sendCommentEmail).not.toHaveBeenCalled();
  });

  it("reply: notifies the owner + thread participants, excluding the author, deduped", async () => {
    // Reply authored by BOB. Root authored by ALICE; owner also participated.
    // The DISTINCT participant query returns owner, alice, bob — the orchestrator
    // must drop bob (author) and dedupe the owner (already added as owner).
    routeQuery({
      ownerRows: [{ email: "owner@co.com" }],
      participantRows: [
        { id: OWNER_ID, email: "owner@co.com" },
        { id: ALICE_ID, email: "alice@co.com" },
        { id: BOB_ID, email: "bob@co.com" },
      ],
      parentRows: [{ email: "alice@co.com", body: "name the retention cap here?" }],
    });
    const doc = makeDoc();
    const comment = makeComment({
      id: 88422,
      author_user_id: BOB_ID,
      author_email: "bob@co.com",
      parent_id: 88421,
      body: "+1, 30 days is what we agreed.",
    });

    const res = await sendCommentNotification({ req, doc, comment });

    expect(res.recipients).toBe(2); // owner + alice (bob excluded)
    expect(res.notified).toBe(2);
    const tos = mocks.sendCommentEmail.mock.calls.map((c) => c[0].to).sort();
    expect(tos).toEqual(["alice@co.com", "owner@co.com"]);
    // No recipient is bob.
    expect(tos).not.toContain("bob@co.com");
  });

  it("reply: a participant who LOST access is dropped (owner still notified)", async () => {
    // Carol authored in the thread while she had a grant, then the grant was
    // revoked. She must NOT receive the reply (no post-revocation leakage); the
    // owner still does.
    const CAROL_ID = 4;
    routeQuery({
      ownerRows: [{ email: "owner@co.com" }],
      participantRows: [
        { id: OWNER_ID, email: "owner@co.com" },
        { id: CAROL_ID, email: "carol@ex.com" },
      ],
      grantedEmails: [], // carol no longer holds a grant
      parentRows: [{ email: "owner@co.com", body: "root body" }],
    });
    const doc = makeDoc();
    const comment = makeComment({
      author_user_id: ALICE_ID,
      author_email: "alice@co.com",
      parent_id: 88421,
    });

    const res = await sendCommentNotification({ req, doc, comment });

    expect(res.notified).toBe(1);
    const tos = mocks.sendCommentEmail.mock.calls.map((c) => c[0].to);
    expect(tos).toEqual(["owner@co.com"]);
    expect(tos).not.toContain("carol@ex.com");
  });

  it("reply on a PUBLIC doc: every participant is notified without an access lookup", async () => {
    const CAROL_ID = 4;
    routeQuery({
      ownerRows: [{ email: "owner@co.com" }],
      participantRows: [
        { id: OWNER_ID, email: "owner@co.com" },
        { id: CAROL_ID, email: "carol@ex.com" },
      ],
      grantedEmails: [], // no grants — but a public doc skips the check entirely
      parentRows: [{ email: "owner@co.com", body: "root body" }],
    });
    const doc = makeDoc({ is_public: true });
    const comment = makeComment({
      author_user_id: ALICE_ID,
      author_email: "alice@co.com",
      parent_id: 88421,
    });

    const res = await sendCommentNotification({ req, doc, comment });

    expect(res.notified).toBe(2);
    const tos = mocks.sendCommentEmail.mock.calls.map((c) => c[0].to).sort();
    expect(tos).toEqual(["carol@ex.com", "owner@co.com"]);
    // A public doc must not consult doc_grants for participant access.
    expect(mocks.query.mock.calls.some((c) => String(c[0]).includes("FROM doc_grants"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Footer flavor (owner vs participant).
// ---------------------------------------------------------------------------

describe("footer flavor", () => {
  it("owner recipient gets isOwnerRecipient:true; a non-owner participant gets false", async () => {
    routeQuery({
      ownerRows: [{ email: "owner@co.com" }],
      participantRows: [
        { id: OWNER_ID, email: "owner@co.com" },
        { id: ALICE_ID, email: "alice@co.com" },
      ],
      parentRows: [{ email: "alice@co.com", body: "root body" }],
    });
    const doc = makeDoc();
    const comment = makeComment({
      author_user_id: BOB_ID,
      author_email: "bob@co.com",
      parent_id: 88421,
    });

    await sendCommentNotification({ req, doc, comment });

    const byTo = Object.fromEntries(
      mocks.sendCommentEmail.mock.calls.map((c) => [c[0].to, c[0].isOwnerRecipient])
    );
    expect(byTo["owner@co.com"]).toBe(true);
    expect(byTo["alice@co.com"]).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rate cap (dedicated namespace) + the EMAIL_SEND_LIMITS guard.
// ---------------------------------------------------------------------------

describe("per-recipient rate cap", () => {
  it("a tripped cap skips that recipient's send and audits the trip", async () => {
    mocks.checkLimits.mockResolvedValueOnce({ key: "cmt-notify:addr:owner@co.com", limit: 30, retryAfter: 10 });
    routeQuery({ ownerRows: [{ email: "owner@co.com" }] });
    const doc = makeDoc();
    const comment = makeComment({ author_user_id: ALICE_ID });

    const res = await sendCommentNotification({ req, doc, comment });

    expect(res.notified).toBe(0);
    expect(mocks.sendCommentEmail).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledWith(
      req,
      "rate_limit.tripped",
      expect.objectContaining({ meta: expect.objectContaining({ key: "cmt-notify:addr:owner@co.com" }) })
    );
  });

  it("uses the DEDICATED cmt-notify:addr namespace, 30/day — and NEVER EMAIL_SEND_LIMITS", async () => {
    routeQuery({ ownerRows: [{ email: "owner@co.com" }] });
    const doc = makeDoc();
    const comment = makeComment({ author_user_id: ALICE_ID });

    await sendCommentNotification({ req, doc, comment });

    expect(mocks.checkLimits).toHaveBeenCalledTimes(1);
    expect(mocks.checkLimits.mock.calls[0][0]).toEqual([
      { key: "cmt-notify:addr:owner@co.com", limit: 30, window: "day" },
    ]);
    // The load-bearing budget-isolation guarantee: this path must not consult
    // the shared email-send caps.
    expect(mocks.EMAIL_SEND_LIMITS).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Token mint + idempotency + snippet shape (happy path).
// ---------------------------------------------------------------------------

describe("token mint + email params (happy path)", () => {
  it("mints a 'share' token for the lowercased email with the 7-day TTL and the right idempotency key", async () => {
    const tokenParams: unknown[][] = [];
    routeQuery({
      ownerRows: [{ email: "Owner@CO.com" }], // mixed case → must be lowercased
      onTokenInsert: (p) => tokenParams.push(p),
    });
    const doc = makeDoc();
    const comment = makeComment({ id: 555, author_user_id: ALICE_ID });

    await sendCommentNotification({ req, doc, comment });

    // INSERT params: [email, token_hash, ttlSeconds].
    expect(tokenParams).toHaveLength(1);
    const [email, tokenHash, ttl] = tokenParams[0];
    expect(email).toBe("owner@co.com");
    expect(typeof tokenHash).toBe("string");
    expect(ttl).toBe(String(SHARE_TOKEN_TTL_S)); // 604800

    const sent = mocks.sendCommentEmail.mock.calls[0][0];
    expect(sent.idempotencyKey).toBe(`comment-notify-555-${OWNER_ID}`);
    // The login link carries the freshly minted plaintext token + next=/d/:slug.
    expect(sent.link).toContain("https://justhtml.sh/login/verify?token=lt_");
    expect(sent.link).toContain("next=%2Fd%2Ffierce-tiger-12345");
    expect(sent.docUrl).toBe("https://justhtml.sh/d/fierce-tiger-12345");
  });

  it("truncates a long body to ~180 chars with an ellipsis", async () => {
    routeQuery({ ownerRows: [{ email: "owner@co.com" }] });
    const longBody = "x".repeat(400);
    const doc = makeDoc();
    const comment = makeComment({ author_user_id: ALICE_ID, body: longBody });

    await sendCommentNotification({ req, doc, comment });

    const { bodySnippet } = mocks.sendCommentEmail.mock.calls[0][0];
    expect(bodySnippet.endsWith("…")).toBe(true);
    expect(bodySnippet.length).toBeLessThanOrEqual(181); // 180 + the ellipsis char
  });

  it("top-level anchored comment passes anchor.exact as the anchored quote; reply does not", async () => {
    routeQuery({ ownerRows: [{ email: "owner@co.com" }] });
    const doc = makeDoc();
    const comment = makeComment({
      author_user_id: ALICE_ID,
      anchor: { type: "text", exact: "Each segment retains a full snapshot." },
      orphaned: false,
    });

    await sendCommentNotification({ req, doc, comment });

    const sent = mocks.sendCommentEmail.mock.calls[0][0];
    expect(sent.isReply).toBe(false);
    expect(sent.anchoredQuote).toBe("Each segment retains a full snapshot.");
  });

  it("an orphaned anchor is NOT surfaced as the anchored quote", async () => {
    routeQuery({ ownerRows: [{ email: "owner@co.com" }] });
    const doc = makeDoc();
    const comment = makeComment({
      author_user_id: ALICE_ID,
      anchor: { type: "text", exact: "stale passage" },
      orphaned: true,
    });

    await sendCommentNotification({ req, doc, comment });

    expect(mocks.sendCommentEmail.mock.calls[0][0].anchoredQuote).toBeNull();
  });

  it("reply: looks up parent author + body and passes them as parent context (isReply branch)", async () => {
    routeQuery({
      ownerRows: [{ email: "owner@co.com" }],
      participantRows: [{ id: OWNER_ID, email: "owner@co.com" }],
      parentRows: [{ email: "alice@co.com", body: "name the retention cap here?" }],
    });
    const doc = makeDoc();
    const comment = makeComment({
      id: 88422,
      author_user_id: BOB_ID,
      author_email: "bob@co.com",
      parent_id: 88421,
    });

    await sendCommentNotification({ req, doc, comment });

    const sent = mocks.sendCommentEmail.mock.calls[0][0];
    expect(sent.isReply).toBe(true);
    expect(sent.parentAuthorEmail).toBe("alice@co.com");
    expect(sent.parentSnippet).toBe("name the retention cap here?");
  });
});

// ---------------------------------------------------------------------------
// Send-failure rollback + audit.
// ---------------------------------------------------------------------------

describe("send-failure rollback", () => {
  it("deletes the just-minted token row when the send throws, and does not audit a sent event", async () => {
    const deletedIds: unknown[] = [];
    routeQuery({
      ownerRows: [{ email: "owner@co.com" }],
      onTokenDelete: (p) => deletedIds.push(p[0]),
    });
    mocks.sendCommentEmail.mockRejectedValueOnce(new Error("resend down"));
    const doc = makeDoc();
    const comment = makeComment({ author_user_id: ALICE_ID });

    const res = await sendCommentNotification({ req, doc, comment });

    expect(res.notified).toBe(0);
    expect(deletedIds).toEqual([9000]); // the id the INSERT returned
    expect(mocks.audit).not.toHaveBeenCalledWith(
      req,
      "comment_notification.sent",
      expect.anything()
    );
  });

  it("audits comment_notification.sent on a successful send", async () => {
    routeQuery({ ownerRows: [{ email: "owner@co.com" }] });
    const doc = makeDoc();
    const comment = makeComment({ author_user_id: ALICE_ID });

    await sendCommentNotification({ req, doc, comment });

    expect(mocks.audit).toHaveBeenCalledWith(
      req,
      "comment_notification.sent",
      expect.objectContaining({
        userId: OWNER_ID,
        meta: expect.objectContaining({ doc_id: 100, comment_id: 88421, recipient_email: "owner@co.com" }),
      })
    );
  });
});

// ---------------------------------------------------------------------------
// Thread-participant query shape.
// ---------------------------------------------------------------------------

describe("thread-participant query shape", () => {
  it("queries DISTINCT live, non-null authors across the root and its replies (rootId = parent_id)", async () => {
    const seen: Array<{ sql: string; params: unknown[] }> = [];
    mocks.query.mockImplementation(async (sql: string, params?: unknown[]): Promise<Rows> => {
      seen.push({ sql, params: params ?? [] });
      if (sql.includes("FROM users WHERE id =")) return { rows: [{ email: "owner@co.com" }] };
      if (sql.includes("SELECT DISTINCT u.id, u.email")) return { rows: [] };
      if (sql.includes("SELECT u.email, c.body")) return { rows: [{ email: "alice@co.com", body: "b" }] };
      if (sql.includes("INSERT INTO login_tokens")) return { rows: [{ id: 1 }] };
      return { rows: [] };
    });
    const doc = makeDoc();
    const comment = makeComment({ author_user_id: BOB_ID, parent_id: 88421 });

    await sendCommentNotification({ req, doc, comment });

    const partQ = seen.find((q) => q.sql.includes("SELECT DISTINCT u.id, u.email"));
    expect(partQ).toBeDefined();
    expect(partQ!.sql).toContain("c.id = $2 OR c.parent_id = $2");
    expect(partQ!.sql).toContain("c.deleted_at IS NULL");
    expect(partQ!.sql).toContain("c.author_user_id IS NOT NULL");
    expect(partQ!.params).toEqual([doc.id, 88421]); // [doc_id, rootId = parent_id]
  });

  it("scopes the parent-context lookup by doc_id and live (deleted_at IS NULL)", async () => {
    const seen: Array<{ sql: string; params: unknown[] }> = [];
    mocks.query.mockImplementation(async (sql: string, params?: unknown[]): Promise<Rows> => {
      seen.push({ sql, params: params ?? [] });
      if (sql.includes("FROM users WHERE id =")) return { rows: [{ email: "owner@co.com" }] };
      if (sql.includes("SELECT DISTINCT u.id, u.email")) return { rows: [] };
      if (sql.includes("SELECT u.email, c.body")) return { rows: [{ email: "alice@co.com", body: "b" }] };
      if (sql.includes("INSERT INTO login_tokens")) return { rows: [{ id: 1 }] };
      return { rows: [] };
    });
    const doc = makeDoc();
    const comment = makeComment({ author_user_id: BOB_ID, parent_id: 88421 });

    await sendCommentNotification({ req, doc, comment });

    const parentQ = seen.find((q) => q.sql.includes("SELECT u.email, c.body"));
    expect(parentQ).toBeDefined();
    expect(parentQ!.sql).toContain("c.doc_id = $2");
    expect(parentQ!.sql).toContain("c.deleted_at IS NULL");
    expect(parentQ!.params).toEqual([88421, doc.id]); // [parentId, doc_id]
  });
});
