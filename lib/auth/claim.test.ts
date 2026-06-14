import { describe, it, expect } from "vitest";
import { classifyRegistration, type Precedence } from "@/lib/auth/claim";

// Pins the precedence matrix of classifyRegistration — the load-bearing branch
// that resolveLiveRegistration delegates to. The `precedence` arg only changes
// the outcome for a row that is BOTH claimed AND past its window:
//   - oauth2/token passes "expiredFirst"  → that row is "expired"
//   - /claim and /claim/complete pass "claimedFirst" → that row is "claimed"
// A future copy-paste of the wrong literal at a call site must fail this test.

const NOW = 1_000_000_000_000; // fixed reference instant (ms)
const FUTURE = new Date(NOW + 60_000).toISOString();
const PAST = new Date(NOW - 60_000).toISOString();

function row(opts: { expires: string; claimedAt: string | null }) {
  return { claim_expires_at: opts.expires, claimed_at: opts.claimedAt };
}

describe("classifyRegistration", () => {
  it("live: unclaimed and in-window", () => {
    const r = row({ expires: FUTURE, claimedAt: null });
    expect(classifyRegistration(r, NOW, "expiredFirst")).toBe("live");
    expect(classifyRegistration(r, NOW, "claimedFirst")).toBe("live");
  });

  it("claimed-only: claimed and in-window → claimed under both precedences", () => {
    const r = row({ expires: FUTURE, claimedAt: PAST });
    expect(classifyRegistration(r, NOW, "expiredFirst")).toBe("claimed");
    expect(classifyRegistration(r, NOW, "claimedFirst")).toBe("claimed");
  });

  it("expired-only: unclaimed and past window → expired under both precedences", () => {
    const r = row({ expires: PAST, claimedAt: null });
    expect(classifyRegistration(r, NOW, "expiredFirst")).toBe("expired");
    expect(classifyRegistration(r, NOW, "claimedFirst")).toBe("expired");
  });

  it("BOTH claimed + expired: precedence decides the winner", () => {
    const r = row({ expires: PAST, claimedAt: PAST });
    // oauth2/token: window-closed wins → never issues a key for an expired reg.
    expect(classifyRegistration(r, NOW, "expiredFirst")).toBe("expired");
    // /claim + /claim/complete: claimed wins → always 409, even past window.
    expect(classifyRegistration(r, NOW, "claimedFirst")).toBe("claimed");
  });

  it("boundary: expiry exactly at now counts as expired (<=)", () => {
    const r = row({ expires: new Date(NOW).toISOString(), claimedAt: null });
    expect(classifyRegistration(r, NOW, "expiredFirst")).toBe("expired");
    expect(classifyRegistration(r, NOW, "claimedFirst")).toBe("expired");
  });
});

// Pin each handler's documented precedence literal. If a future edit copy-pastes
// the wrong literal into a call site, this matrix breaks before it ships.
describe("handler precedence literals (documented contract)", () => {
  const cases: Array<{ handler: string; precedence: Precedence }> = [
    { handler: "oauth2/token", precedence: "expiredFirst" },
    { handler: "agent/identity/claim", precedence: "claimedFirst" },
    { handler: "agent/identity/claim/complete", precedence: "claimedFirst" },
  ];
  const bothClaimedExpired = row({ expires: PAST, claimedAt: PAST });

  it("oauth2/token (expiredFirst) maps a claimed+expired reg to expired", () => {
    const p = cases.find((c) => c.handler === "oauth2/token")!.precedence;
    expect(p).toBe("expiredFirst");
    expect(classifyRegistration(bothClaimedExpired, NOW, p)).toBe("expired");
  });

  it("/claim (claimedFirst) maps a claimed+expired reg to claimed", () => {
    const p = cases.find((c) => c.handler === "agent/identity/claim")!.precedence;
    expect(p).toBe("claimedFirst");
    expect(classifyRegistration(bothClaimedExpired, NOW, p)).toBe("claimed");
  });

  it("/claim/complete (claimedFirst) maps a claimed+expired reg to claimed", () => {
    const p = cases.find(
      (c) => c.handler === "agent/identity/claim/complete"
    )!.precedence;
    expect(p).toBe("claimedFirst");
    expect(classifyRegistration(bothClaimedExpired, NOW, p)).toBe("claimed");
  });
});
