// End-to-end smoke test for justhtml.sh core flows — black-box, no app backdoor.
//
// The hard part of testing this product is the human "read the inbox" step. This
// harness does exactly what a human does: it registers with a REAL throwaway
// inbox (AgentMail), then reads the 6-digit code / magic link back over the
// AgentMail API. It reads real emails, so it needs no app-side test secret.
//
//   AGENTMAIL_AGENTMAIL_API_KEY  (in .env; provisioned via Stripe Projects)
//   BASE_URL                      default https://justhtml.sh
//
// Run:  npm run e2e        (tsx scripts/e2e.ts)
// Exits non-zero if any assertion fails.

const BASE = (process.env.BASE_URL ?? "https://justhtml.sh").replace(/\/$/, "");
const AM_KEY = process.env.AGENTMAIL_AGENTMAIL_API_KEY;
const AM = "https://api.agentmail.to/v0";
const CLAIM_GRANT = "urn:workos:agent-auth:grant-type:claim";

if (!AM_KEY) {
  console.error("AGENTMAIL_AGENTMAIL_API_KEY is required (load .env: `npm run e2e`).");
  process.exit(2);
}

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// deterministic-enough unique suffix without Date.now()/Math.random (which are
// fine in a normal script, but a counter keeps log lines stable across reruns).
let n = 0;
const tag = () => `${process.pid}-${++n}`;

async function am(path: string, init: RequestInit = {}) {
  const r = await fetch(`${AM}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${AM_KEY}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  if (!r.ok) throw new Error(`AgentMail ${path} -> ${r.status} ${await r.text()}`);
  return r.json() as Promise<any>;
}

async function createInbox(): Promise<string> {
  const inbox = await am("/inboxes", { method: "POST", body: "{}" });
  return inbox.inbox_id as string;
}

// Poll an inbox until a message whose subject matches `subjectIncludes` arrives;
// return its full body { text, html }.
async function waitForEmail(inbox: string, subjectIncludes: string, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const list = await am(`/inboxes/${encodeURIComponent(inbox)}/messages`);
    const hit = (list.messages ?? []).find((m: any) => (m.subject ?? "").includes(subjectIncludes));
    if (hit) {
      const full = await am(`/inboxes/${encodeURIComponent(inbox)}/messages/${encodeURIComponent(hit.message_id)}`);
      return { text: (full.text as string) ?? "", html: (full.html as string) ?? "" };
    }
    await sleep(3000);
  }
  throw new Error(`timed out waiting for email "${subjectIncludes}" in ${inbox}`);
}

async function jh(path: string, init: RequestInit = {}) {
  return fetch(`${BASE}${path}`, init);
}
const authJson = (key: string) => ({ Authorization: `Bearer ${key}`, "Content-Type": "application/json" });

// Full claim ceremony for an inbox -> jh_live_ key. Exactly the documented flow.
async function registerAndGetKey(inbox: string): Promise<string> {
  const reg = await (await jh("/agent/identity", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "service_auth", login_hint: inbox }),
  })).json();
  const claimToken = reg.claim_token as string;
  if (!claimToken) throw new Error(`no claim_token in /agent/identity response: ${JSON.stringify(reg)}`);

  const email = await waitForEmail(inbox, "your justhtml.sh code");
  const code = (email.text.match(/\b\d{6}\b/) ?? email.html.match(/\b\d{6}\b/))?.[0];
  if (!code) throw new Error("no 6-digit code in claim email");

  const complete = await jh("/agent/identity/claim/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ claim_token: claimToken, user_code: code }),
  });
  if (!complete.ok) throw new Error(`claim/complete -> ${complete.status} ${await complete.text()}`);

  for (let i = 0; i < 20; i++) {
    const body = new URLSearchParams({ grant_type: CLAIM_GRANT, claim_token: claimToken });
    const tok = await (await jh("/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    })).json();
    if (tok.access_token) return tok.access_token as string;
    if (tok.error && tok.error !== "authorization_pending" && tok.error !== "slow_down") {
      throw new Error(`token poll error: ${JSON.stringify(tok)}`);
    }
    await sleep(2000);
  }
  throw new Error("token poll timed out");
}

async function main() {
  console.log(`e2e against ${BASE}\n`);

  // --- Phase 1: registration ceremony (claim email via AgentMail) ---
  console.log("Phase 1 — register (owner)");
  const ownerInbox = await createInbox();
  console.log(`  owner inbox: ${ownerInbox}`);
  const ownerKey = await registerAndGetKey(ownerInbox);
  check("owner got a jh_live_ key", ownerKey.startsWith("jh_live_"), ownerKey.slice(0, 12));
  const meRes = await jh("/api/v1/docs", { headers: { Authorization: `Bearer ${ownerKey}` } });
  check("key authenticates GET /api/v1/docs", meRes.status === 200, `status ${meRes.status}`);

  // --- Phase 2: publish + fetch + sandboxed raw ---
  console.log("Phase 2 — publish");
  const marker = `e2e-${tag()}`;
  const phrase = `the load-bearing sentence ${marker}`;
  const created = await (await jh("/api/v1/docs", {
    method: "POST",
    headers: authJson(ownerKey),
    body: JSON.stringify({ html: `<h1>E2E ${marker}</h1><p>${phrase}.</p>`, title: `E2E ${marker}` }),
  })).json();
  const slug = created.slug as string;
  check("doc created with slug", !!slug, JSON.stringify(created).slice(0, 80));
  check("create returned a view_token + version 1", !!created.view_token && created.version === 1);
  const rawNoTok = await jh(`/d/${slug}/raw`);
  check("private /raw without token is not 200", rawNoTok.status !== 200, `status ${rawNoTok.status}`);
  const rawTok = await jh(`/d/${slug}/raw?viewtoken=${created.view_token}`);
  const rawBody = await rawTok.text();
  check("private /raw with token renders the html", rawTok.status === 200 && rawBody.includes(marker));
  check("/raw sets sandbox CSP", (rawTok.headers.get("content-security-policy") ?? "").includes("sandbox"));

  // --- Phase 3: deterministic edit + history + version bump ---
  console.log("Phase 3 — edit");
  const edit = await jh(`/api/v1/docs/${slug}/edits`, {
    method: "POST",
    headers: authJson(ownerKey),
    body: JSON.stringify({ edits: [{ oldText: "load-bearing", newText: "rewritten" }], base_version: 1 }),
  });
  const editJson = await edit.json();
  check("edit applied, version -> 2", edit.status === 200 && editJson.version === 2, `status ${edit.status}`);
  const stale = await jh(`/api/v1/docs/${slug}/edits`, {
    method: "POST",
    headers: authJson(ownerKey),
    body: JSON.stringify({ edits: [{ oldText: "rewritten", newText: "x" }], base_version: 1 }),
  });
  check("stale base_version -> 409", stale.status === 409, `status ${stale.status}`);
  const versions = await (await jh(`/api/v1/docs/${slug}/versions`, { headers: { Authorization: `Bearer ${ownerKey}` } })).json();
  check("history has >= 2 versions", (versions.versions ?? versions).length >= 2);

  // --- Phase 4: comment (anchored) + reaction (anchored span) ---
  console.log("Phase 4 — comment + react");
  const comment = await jh(`/api/v1/docs/${slug}/comments`, {
    method: "POST",
    headers: authJson(ownerKey),
    body: JSON.stringify({ body: "is this right?", anchor: { exact: `sentence ${marker}`, prefix: "the rewritten ", suffix: "." } }),
  });
  const commentJson = await comment.json();
  check("anchored comment created", comment.status === 201 && !!commentJson.comment?.id, `status ${comment.status}`);
  const react = await jh(`/api/v1/docs/${slug}/reactions`, {
    method: "POST",
    headers: authJson(ownerKey),
    body: JSON.stringify({ emoji: "🚀", anchor: { exact: `E2E ${marker}`, prefix: "", suffix: "" } }),
  });
  check("anchored reaction created", react.status === 201, `status ${react.status}`);
  const threads = await (await jh(`/api/v1/docs/${slug}/comments`, { headers: { Authorization: `Bearer ${ownerKey}` } })).json();
  check("GET /comments returns the thread", (threads.threads ?? []).length >= 1);

  // --- Phase 5: share by email -> grantee gets a one-click login that lands on the doc ---
  console.log("Phase 5 — share + grantee one-click login");
  const granteeInbox = await createInbox();
  console.log(`  grantee inbox: ${granteeInbox}`);
  const grant = await jh(`/api/v1/docs/${slug}/grants`, {
    method: "POST",
    headers: authJson(ownerKey),
    body: JSON.stringify({ email: granteeInbox, role: "editor" }),
  });
  const grantJson = await grant.json();
  check("editor grant created + notified", grant.status === 201 && grantJson.notified === true, `status ${grant.status}`);
  const shareEmail = await waitForEmail(granteeInbox, "shared");
  const link = (shareEmail.text.match(/https:\/\/[^\s)]+\/login\/verify\?[^\s)]+/) ??
    shareEmail.html.match(/https:\/\/[^\s"')]+\/login\/verify\?[^\s"')]+/))?.[0]?.replace(/&amp;/g, "&");
  check("share email carries a login/verify link", !!link, (link ?? "").slice(0, 60));
  if (link) {
    const path = link.slice(BASE.length);
    const getConfirm = await jh(path); // GET = scanner-safe confirm, must NOT consume
    check("verify GET is a 200 confirm page", getConfirm.status === 200, `status ${getConfirm.status}`);
    // Consume = submit the confirm form: token + next as a form-encoded body
    // (matching the page's <form>), with a same-origin Origin header for CSRF.
    const q = new URL(link).searchParams;
    const form = new URLSearchParams({ token: q.get("token") ?? "", next: q.get("next") ?? "" });
    const postConsume = await jh("/login/verify", {
      method: "POST",
      headers: { Origin: BASE, "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
      redirect: "manual",
    });
    const cookie = (postConsume.headers.getSetCookie?.() ?? []).find((c) => c.startsWith("jh_sess="));
    const loc = postConsume.headers.get("location") ?? "";
    check("verify POST signs in (303 + jh_sess) to the doc", (postConsume.status === 303) && !!cookie && loc.includes(`/d/${slug}`), `status ${postConsume.status} loc ${loc}`);
    if (cookie) {
      const sess = cookie.split(";")[0];
      const asGrantee = await jh(`/d/${slug}`, { headers: { Cookie: sess } });
      check("grantee session views the private doc (no token)", asGrantee.status === 200, `status ${asGrantee.status}`);
    }
  }

  // --- Phase 6: delete the test doc, then revoke ---
  console.log("Phase 6 — delete + revoke");
  const del = await jh(`/api/v1/docs/${slug}`, { method: "DELETE", headers: { Authorization: `Bearer ${ownerKey}` } });
  check("test doc soft-deleted", del.status === 200 || del.status === 204, `status ${del.status}`);
  await jh("/oauth2/revoke", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: ownerKey }) });
  const afterRevoke = await jh("/api/v1/docs", { headers: { Authorization: `Bearer ${ownerKey}` } });
  check("revoked key is rejected (401)", afterRevoke.status === 401, `status ${afterRevoke.status}`);

  // --- Cleanup (best-effort; revoked key can't delete docs, so do it before? leave soft doc) ---
  await am(`/inboxes/${encodeURIComponent(ownerInbox)}`, { method: "DELETE" }).catch(() => {});
  await am(`/inboxes/${encodeURIComponent(granteeInbox)}`, { method: "DELETE" }).catch(() => {});

  console.log(`\n${passed} checks passed, ${failures.length} failed.`);
  if (failures.length) {
    console.log("FAILURES:\n" + failures.map((f) => `  - ${f}`).join("\n"));
    process.exit(1);
  }
  console.log("E2E PASSED ✅");
}

main().catch((e) => {
  console.error("\nE2E ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
