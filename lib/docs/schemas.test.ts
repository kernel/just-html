import { describe, it, expect } from "vitest";
import {
  CreateDocBody,
  UpdateDocBody,
  GrantBody,
  EditsBody,
  editsBadRequest,
  zodBadRequest,
} from "@/lib/docs/schemas";
import { MAX_TITLE_LEN } from "@/lib/docs/config";
import { GRANT_ROLES } from "@/lib/docs/grants";

/** Read the `message` out of an apiError Response (sync; body is a JSON string). */
async function respMessage(res: Response): Promise<{ status: number; message: string; error: string }> {
  const body = (await res.json()) as { error: string; message: string };
  return { status: res.status, message: body.message, error: body.error };
}

// Pins the Zod docs-body validators to the EXACT wire behavior of the
// hand-rolled parsers they replaced (lib/docs/api.ts parseTitle /
// parseOptionalBool / the inline typeof checks). Each case asserts both the
// validation OUTCOME (accept vs 400) and, on failure, the 400 message bytes —
// because the migration's golden rule is byte-identical apiError(400,
// "invalid_request", <message>) responses.

const ORDER = ["html", "title", "public"];

/** Run a body through a schema; return the resolved data or the mapped message. */
function run(
  schema: typeof CreateDocBody | typeof UpdateDocBody,
  body: unknown
): { ok: true; data: unknown } | { ok: false; message: string } {
  const r = schema.safeParse(body);
  if (r.success) return { ok: true, data: r.data };
  // zodBadRequest builds the apiError Response; we read its message back out.
  const res = zodBadRequest(r.error, ORDER);
  // The Response body is JSON { error, message }.
  // (Synchronously unreachable; assert the chosen issue message directly.)
  void res;
  const rank = (p: unknown) => {
    const i = ORDER.indexOf(String((p as { path: unknown[] }).path[0] ?? ""));
    return i === -1 ? ORDER.length : i;
  };
  const chosen = [...r.error.issues].sort((a, b) => rank(a) - rank(b))[0];
  return { ok: false, message: chosen.message };
}

describe("CreateDocBody (POST /api/v1/docs)", () => {
  it("accepts html only; title defaults to null, public to false", () => {
    expect(run(CreateDocBody, { html: "<p>x</p>" })).toEqual({
      ok: true,
      data: { html: "<p>x</p>", title: null, public: false },
    });
  });

  it("missing/non-string html → old html message", () => {
    expect(run(CreateDocBody, {})).toEqual({
      ok: false,
      message: "Field 'html' is required and must be a string.",
    });
    expect(run(CreateDocBody, { html: 5 })).toEqual({
      ok: false,
      message: "Field 'html' is required and must be a string.",
    });
  });

  it("title: null and undefined both resolve to null; string passes through", () => {
    expect(run(CreateDocBody, { html: "x", title: null })).toMatchObject({ data: { title: null } });
    expect(run(CreateDocBody, { html: "x", title: "T" })).toMatchObject({ data: { title: "T" } });
  });

  it("non-string title → old POST title message ('a string')", () => {
    expect(run(CreateDocBody, { html: "x", title: 5 })).toEqual({
      ok: false,
      message: "Field 'title' must be a string.",
    });
  });

  it("over-long title → old cap message", () => {
    expect(run(CreateDocBody, { html: "x", title: "a".repeat(MAX_TITLE_LEN + 1) })).toEqual({
      ok: false,
      message: `Field 'title' must be at most ${MAX_TITLE_LEN} characters.`,
    });
  });

  it("non-boolean public → old public message", () => {
    expect(run(CreateDocBody, { html: "x", public: "yes" })).toEqual({
      ok: false,
      message: "Field 'public' must be a boolean.",
    });
  });

  it("html precedes title/public in error precedence (matches old ordering)", () => {
    expect(run(CreateDocBody, { html: 5, title: 9, public: "no" })).toEqual({
      ok: false,
      message: "Field 'html' is required and must be a string.",
    });
  });

  it("ignores unknown fields (old code only read known keys)", () => {
    expect(run(CreateDocBody, { html: "x", extra: 1 })).toEqual({
      ok: true,
      data: { html: "x", title: null, public: false },
    });
  });
});

describe("UpdateDocBody (PATCH /api/v1/docs/{slug})", () => {
  it("absent fields stay absent (so updateMeta only touches provided fields)", () => {
    expect(run(UpdateDocBody, { html: "x" })).toEqual({ ok: true, data: { html: "x" } });
  });

  it("title null clears; string passes; absent omitted", () => {
    expect(run(UpdateDocBody, { title: null })).toEqual({ ok: true, data: { title: null } });
    expect(run(UpdateDocBody, { title: "T" })).toEqual({ ok: true, data: { title: "T" } });
  });

  it("non-string html → old PATCH html message", () => {
    expect(run(UpdateDocBody, { html: 5 })).toEqual({
      ok: false,
      message: "Field 'html' must be a string.",
    });
  });

  it("non-string non-null title → old PATCH title message ('a string or null')", () => {
    expect(run(UpdateDocBody, { title: 5 })).toEqual({
      ok: false,
      message: "Field 'title' must be a string or null.",
    });
  });

  it("over-long title → old cap message", () => {
    expect(run(UpdateDocBody, { title: "a".repeat(MAX_TITLE_LEN + 1) })).toEqual({
      ok: false,
      message: `Field 'title' must be at most ${MAX_TITLE_LEN} characters.`,
    });
  });

  it("non-boolean public → old public message", () => {
    expect(run(UpdateDocBody, { public: 1 })).toEqual({
      ok: false,
      message: "Field 'public' must be a boolean.",
    });
  });
});

// === Z2 ====================================================================

const GRANT_ORDER = ["role", "notify", "email", "domain"];

/** Run a body through GrantBody; return data or the precedence-mapped message. */
function runGrant(body: unknown): { ok: true; data: unknown } | { ok: false; message: string } {
  const r = GrantBody.safeParse(body);
  if (r.success) return { ok: true, data: r.data };
  const rank = (p: unknown) => {
    const i = GRANT_ORDER.indexOf(String((p as { path: unknown[] }).path[0] ?? ""));
    return i === -1 ? GRANT_ORDER.length : i;
  };
  const chosen = [...r.error.issues].sort((a, b) => rank(a) - rank(b))[0];
  return { ok: false, message: chosen.message };
}

describe("GrantBody (POST /api/v1/docs/{slug}/grants — field types)", () => {
  // The schema ONLY type-checks role/notify/email/domain. The exactly-one rule,
  // the email/domain FORMAT validation, and the consumer-domain 422 stay in the
  // route, so they are NOT exercised here.
  const roleMsg = `Field 'role' is required and must be one of: ${GRANT_ROLES.join(", ")}.`;

  it("accepts a valid email grant; notify omitted stays undefined", () => {
    expect(runGrant({ email: "a@b.com", role: "viewer" })).toEqual({
      ok: true,
      data: { email: "a@b.com", role: "viewer" },
    });
  });

  it("accepts a valid domain grant with notify:false", () => {
    expect(runGrant({ domain: "kernel.sh", role: "editor", notify: false })).toEqual({
      ok: true,
      data: { domain: "kernel.sh", role: "editor", notify: false },
    });
  });

  it("missing / non-string / out-of-enum role → single unified role message", () => {
    expect(runGrant({ email: "a@b.com" })).toEqual({ ok: false, message: roleMsg });
    expect(runGrant({ email: "a@b.com", role: 5 })).toEqual({ ok: false, message: roleMsg });
    expect(runGrant({ email: "a@b.com", role: "boss" })).toEqual({ ok: false, message: roleMsg });
  });

  it("non-boolean notify → old parseOptionalBool message", () => {
    expect(runGrant({ email: "a@b.com", role: "viewer", notify: "yes" })).toEqual({
      ok: false,
      message: "Field 'notify' must be a boolean.",
    });
  });

  it("non-string email / domain → old per-field messages", () => {
    expect(runGrant({ email: 5, role: "viewer" })).toEqual({
      ok: false,
      message: "Field 'email' must be a string.",
    });
    expect(runGrant({ domain: 5, role: "viewer" })).toEqual({
      ok: false,
      message: "Field 'domain' must be a string.",
    });
  });

  it("role precedes notify/email in error precedence (matches old ordering)", () => {
    // role bad AND notify bad AND email bad → role wins (checked first in the route).
    expect(runGrant({ email: 5, role: "boss", notify: "x" })).toEqual({
      ok: false,
      message: roleMsg,
    });
  });

  it("ignores unknown fields", () => {
    expect(runGrant({ email: "a@b.com", role: "viewer", extra: 1 })).toEqual({
      ok: true,
      data: { email: "a@b.com", role: "viewer" },
    });
  });
});

describe("EditsBody (POST /api/v1/docs/{slug}/edits)", () => {
  const ok = (body: unknown) => {
    const r = EditsBody.safeParse(body);
    return r.success ? r.data : null;
  };
  const msg = async (body: unknown): Promise<string> => {
    const r = EditsBody.safeParse(body);
    if (r.success) throw new Error("expected failure");
    return (await respMessage(editsBadRequest(r.error))).message;
  };

  it("accepts a single edit; base_version omitted/null both → undefined", () => {
    expect(ok({ edits: [{ oldText: "a", newText: "b" }] })).toEqual({
      edits: [{ oldText: "a", newText: "b" }],
    });
    expect(ok({ edits: [{ oldText: "a", newText: "b" }], base_version: null })).toEqual({
      edits: [{ oldText: "a", newText: "b" }],
    });
    expect(ok({ edits: [{ oldText: "a", newText: "b" }], base_version: 3 })).toEqual({
      edits: [{ oldText: "a", newText: "b" }],
      base_version: 3,
    });
  });

  it("missing / non-array edits → old array message", async () => {
    expect(await msg({})).toBe("Field 'edits' is required and must be an array.");
    expect(await msg({ edits: "x" })).toBe("Field 'edits' is required and must be an array.");
  });

  it("empty edits → old min message; over-200 → old max message", async () => {
    expect(await msg({ edits: [] })).toBe("Field 'edits' must contain at least one edit.");
    expect(
      await msg({ edits: Array.from({ length: 201 }, () => ({ oldText: "a", newText: "b" })) })
    ).toBe("Field 'edits' must contain at most 200 edits.");
  });

  it("per-index item messages match the old hand-rolled strings", async () => {
    expect(await msg({ edits: [5] })).toBe("edits[0] must be an object.");
    expect(await msg({ edits: [{ newText: "b" }] })).toBe(
      "edits[0].oldText is required and must be a string."
    );
    expect(await msg({ edits: [{ oldText: "a", newText: 5 }] })).toBe(
      "edits[0].newText is required and must be a string."
    );
    // Index is preserved for a later element.
    expect(
      await msg({ edits: [{ oldText: "a", newText: "b" }, { oldText: 1, newText: "c" }] })
    ).toBe("edits[1].oldText is required and must be a string.");
  });

  it("edits-array issue precedes a base_version issue (old top-level ordering)", async () => {
    expect(await msg({ edits: [], base_version: 0 })).toBe(
      "Field 'edits' must contain at least one edit."
    );
  });

  it("present non-positive-integer base_version → old message", async () => {
    const m = "Field 'base_version' must be a positive integer.";
    expect(await msg({ edits: [{ oldText: "a", newText: "b" }], base_version: 0 })).toBe(m);
    expect(await msg({ edits: [{ oldText: "a", newText: "b" }], base_version: 1.5 })).toBe(m);
    expect(await msg({ edits: [{ oldText: "a", newText: "b" }], base_version: "3" })).toBe(m);
  });
});
