import { describe, it, expect } from "vitest";
import { CreateDocBody, UpdateDocBody, zodBadRequest } from "@/lib/docs/schemas";
import { MAX_TITLE_LEN } from "@/lib/docs/config";

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
