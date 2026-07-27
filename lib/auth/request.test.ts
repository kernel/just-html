import { describe, it, expect, afterEach } from "vitest";
import { originOk, linkOrigin } from "@/lib/auth/request";
import { ORIGIN } from "@/lib/auth/config";

// The Origin/Host handling has two jobs that pull in opposite directions: accept
// a preview deployment's own origin (so reviewers can sign in), while never
// letting a request's Host decide where an emailed login token is sent.

const PREVIEW = "justhtml-abc123-onkernel.vercel.app";
const BRANCH = "justhtml-git-some-branch-onkernel.vercel.app";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

function env(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

/** A request as the edge presents it: forwarded host/proto plus an Origin. */
function req(host: string, origin?: string, proto = "https"): Request {
  const h = new Headers({ "x-forwarded-host": host, "x-forwarded-proto": proto });
  if (origin) h.set("origin", origin);
  return new Request(`${proto}://${host}/login`, { method: "POST", headers: h });
}

describe("originOk", () => {
  it("allows the canonical origin and an absent Origin header", () => {
    env({ VERCEL_ENV: "production" });
    expect(originOk(req("justhtml.sh", ORIGIN))).toBe(true);
    expect(originOk(req("justhtml.sh"))).toBe(true);
  });

  it("rejects a cross-site Origin", () => {
    env({ VERCEL_ENV: "production" });
    expect(originOk(req("justhtml.sh", "https://evil.example"))).toBe(false);
  });

  it("accepts a preview deployment's own origin, by deployment or branch URL", () => {
    env({ VERCEL_ENV: "preview", VERCEL_URL: PREVIEW, VERCEL_BRANCH_URL: BRANCH });
    expect(originOk(req(PREVIEW, `https://${PREVIEW}`))).toBe(true);
    expect(originOk(req(BRANCH, `https://${BRANCH}`))).toBe(true);
    // Still the canonical origin, and still no one else.
    expect(originOk(req(PREVIEW, ORIGIN))).toBe(true);
    expect(originOk(req(PREVIEW, "https://evil.example"))).toBe(false);
  });

  it("keeps production strict even though VERCEL_URL is set there too", () => {
    env({ VERCEL_ENV: "production", VERCEL_URL: PREVIEW, VERCEL_BRANCH_URL: undefined });
    expect(originOk(req("justhtml.sh", `https://${PREVIEW}`))).toBe(false);
  });

  it("accepts localhost only outside Vercel", () => {
    env({ VERCEL_ENV: undefined, VERCEL_URL: undefined, VERCEL_BRANCH_URL: undefined, PORT: undefined });
    expect(originOk(req("localhost:3000", "http://localhost:3000", "http"))).toBe(true);
    env({ VERCEL_ENV: "preview", VERCEL_URL: PREVIEW });
    expect(originOk(req(PREVIEW, "http://localhost:3000"))).toBe(false);
  });
});

describe("linkOrigin", () => {
  it("always links to the canonical origin in production", () => {
    env({ VERCEL_ENV: "production", VERCEL_URL: PREVIEW });
    expect(linkOrigin(req("justhtml.sh"))).toBe(ORIGIN);
    expect(linkOrigin(req(PREVIEW))).toBe(ORIGIN);
  });

  it("links back to the preview the request arrived on", () => {
    env({ VERCEL_ENV: "preview", VERCEL_URL: PREVIEW, VERCEL_BRANCH_URL: BRANCH });
    expect(linkOrigin(req(PREVIEW))).toBe(`https://${PREVIEW}`);
    expect(linkOrigin(req(BRANCH))).toBe(`https://${BRANCH}`);
  });

  it("ignores a forged Host — a login token is never mailed to an unknown domain", () => {
    env({ VERCEL_ENV: "preview", VERCEL_URL: PREVIEW, VERCEL_BRANCH_URL: BRANCH });
    expect(linkOrigin(req("evil.example"))).toBe(ORIGIN);
    // Including a look-alike that merely ends in the right suffix.
    expect(linkOrigin(req("justhtml-abc123-onkernel.vercel.app.evil.example"))).toBe(ORIGIN);
  });
});
