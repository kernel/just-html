// B9 hybrid claim ceremony QA against production.
// Usage: node --env-file=.env scripts/qa-b9.mjs
//
// Exercises: email-mode registration (user_code OMITTED), the approve-link
// completion (GET confirm + POST consume -> session + /docs), the agent
// read-back completion (/agent/identity/claim/complete), spec-pure agent mode
// still works, claim-aware /login copy, wrong-code attempts + 5-attempt death,
// wrong_delivery_mode guard, and re-mint re-emailing.

const BASE = "https://justhtml.sh";
const QA = process.env.QA_SECRET;
if (!QA) { console.error("QA_SECRET not set"); process.exit(1); }

const TS = Date.now().toString(36);
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let PASS = 0, FAIL = 0;
function ok(cond, label, extra) {
  if (cond) { PASS++; log(`  PASS ${label}`); }
  else { FAIL++; log(`  FAIL ${label}${extra ? " :: " + JSON.stringify(extra) : ""}`); }
}

async function jpost(path, body, headers = {}) {
  const r = await fetch(BASE + path, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, json: j, res: r };
}
async function form(path, params, headers = {}) {
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: BASE, ...headers },
    body: new URLSearchParams(params).toString(), redirect: "manual",
  });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, json: j, res: r };
}
async function getHtml(path, headers = {}) {
  const r = await fetch(BASE + path, { headers, redirect: "manual" });
  return { status: r.status, text: await r.text(), res: r };
}
async function qaClaimEmail(email) {
  const r = await fetch(`${BASE}/internal/qa/latest-claim-email?email=${encodeURIComponent(email)}`, {
    headers: { "X-QA-Secret": QA },
  });
  return { status: r.status, json: r.status === 200 ? await r.json() : null };
}
async function pollToken(claimToken, tries = 8) {
  for (let i = 0; i < tries; i++) {
    const tok = await form("/oauth2/token", {
      grant_type: "urn:workos:agent-auth:grant-type:claim", claim_token: claimToken,
    });
    if (tok.status === 200 && tok.json?.access_token) return tok.json.access_token;
    await sleep(1500);
  }
  return null;
}

async function main() {
  // ---- 1. EMAIL MODE (default): user_code omitted; complete via approve link ----
  log("\n[1] email mode (default) — approve-link completion");
  const e1 = `raf+qa-b9-approve-${TS}@kernel.sh`;
  const reg1 = await jpost("/agent/identity", { type: "service_auth", login_hint: e1 });
  ok(reg1.status === 200, "register 200", reg1);
  ok(reg1.json?.claim?.delivery === "email", "claim.delivery=email", reg1.json?.claim);
  ok(reg1.json?.claim?.user_code === undefined, "user_code OMITTED in email mode", reg1.json?.claim);
  ok(reg1.json?.claim?.verification_uri === undefined, "verification_uri omitted in email mode");
  ok(typeof reg1.json?.claim?.complete_url === "string", "complete_url present");
  const ct1 = reg1.json?.claim_token;

  const ce1 = await qaClaimEmail(e1);
  ok(ce1.status === 200 && ce1.json?.approve_link && ce1.json?.code, "claim email captured (code + approve link)", ce1);
  const approveLink = ce1.json.approve_link;
  const approveToken = new URL(approveLink).searchParams.get("token");
  ok(approveToken?.startsWith("cva_"), "approve token is cva_…", approveToken?.slice(0, 6));

  // GET approve = scanner-safe confirm page, does NOT consume.
  const gApprove = await getHtml(`/claim/approve?token=${approveToken}`);
  ok(gApprove.status === 200 && /APPROVE API KEY/.test(gApprove.text), "GET /claim/approve shows confirm page", gApprove.status);
  ok(gApprove.text.includes(e1), "confirm page names the email");
  // Poll still pending (GET did not consume).
  const pend = await form("/oauth2/token", { grant_type: "urn:workos:agent-auth:grant-type:claim", claim_token: ct1 });
  ok(pend.json?.error === "authorization_pending", "still pending after GET approve (not consumed)", pend.json);

  // POST approve consumes -> session + 303 /docs.
  const pApprove = await form("/claim/approve", { token: approveToken });
  ok(pApprove.status === 303 && pApprove.res.headers.get("location") === "/docs", "POST approve 303 -> /docs", pApprove.status);
  ok(/jh_sess=sess_/.test(pApprove.res.headers.get("set-cookie") || ""), "POST approve mints a session cookie");
  // Agent poll now returns the key.
  const key1 = await pollToken(ct1);
  ok(typeof key1 === "string" && key1.startsWith("jh_live_"), "agent poll returns jh_live_ key after approve", key1?.slice(0, 12));
  // Approve link is single-use now (second POST -> already-approved page).
  const pApprove2Res = await fetch(BASE + "/claim/approve", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: BASE },
    body: new URLSearchParams({ token: approveToken }).toString(),
    redirect: "manual",
  });
  const pApprove2Text = await pApprove2Res.text();
  ok(pApprove2Res.status === 200 && /ALREADY APPROVED/.test(pApprove2Text), "second POST approve is already-approved", pApprove2Res.status);

  // ---- 2. EMAIL MODE — complete via agent read-back ----
  log("\n[2] email mode — agent read-back completion (/claim/complete)");
  const e2 = `raf+qa-b9-readback-${TS}@kernel.sh`;
  const reg2 = await jpost("/agent/identity", { type: "service_auth", login_hint: e2 });
  const ct2 = reg2.json?.claim_token;
  const ce2 = await qaClaimEmail(e2);
  const code2 = ce2.json?.code;
  ok(/^[0-9]{6}$/.test(code2 || ""), "got 6-digit code from email", code2);

  // Wrong code first (shares the 5-attempt budget).
  const wrong = await jpost("/agent/identity/claim/complete", { claim_token: ct2, user_code: "000000" });
  ok(wrong.status === 401 && wrong.json?.error === "invalid_user_code", "wrong code -> 401 invalid_user_code", wrong.json);
  ok(/attempt/.test(wrong.json?.message || ""), "wrong-code message names attempts remaining", wrong.json?.message);

  // Correct code completes.
  const right = await jpost("/agent/identity/claim/complete", { claim_token: ct2, user_code: code2 });
  ok(right.status === 200 && right.json?.status === "claimed", "correct code -> 200 claimed", right.json);
  const key2 = await pollToken(ct2);
  ok(key2?.startsWith("jh_live_"), "agent poll returns key after read-back", key2?.slice(0, 12));
  // Re-submitting a claimed registration -> 409.
  const reclaim = await jpost("/agent/identity/claim/complete", { claim_token: ct2, user_code: code2 });
  ok(reclaim.status === 409 && reclaim.json?.error === "claimed_or_in_flight", "re-complete -> 409 claimed_or_in_flight", reclaim.json);

  // ---- 3. EMAIL MODE — 5 wrong attempts kills the code ----
  log("\n[3] email mode — 5 wrong attempts -> code_dead");
  const e3 = `raf+qa-b9-dead-${TS}@kernel.sh`;
  const reg3 = await jpost("/agent/identity", { type: "service_auth", login_hint: e3 });
  const ct3 = reg3.json?.claim_token;
  await qaClaimEmail(e3); // ensure sent
  let lastDead = null;
  for (let i = 1; i <= 5; i++) {
    lastDead = await jpost("/agent/identity/claim/complete", { claim_token: ct3, user_code: "111111" });
  }
  ok(lastDead?.status === 410 && lastDead?.json?.error === "code_dead", "5th wrong attempt -> 410 code_dead", lastDead?.json);
  // Re-mint after death -> fresh email.
  const remint = await jpost("/agent/identity/claim", { claim_token: ct3, email: e3 });
  ok(remint.status === 200 && remint.json?.claim_attempt?.delivery === "email", "re-mint in email mode -> 200 delivery=email", remint.json?.claim_attempt);
  const ce3b = await qaClaimEmail(e3);
  ok(ce3b.json?.code && ce3b.json.code !== "111111", "re-mint produced a fresh emailed code", ce3b.json?.code);
  // The fresh code completes the previously-dead registration.
  const right3 = await jpost("/agent/identity/claim/complete", { claim_token: ct3, user_code: ce3b.json.code });
  ok(right3.status === 200 && right3.json?.status === "claimed", "fresh code after re-mint -> claimed", right3.json);

  // ---- 4. SPEC-PURE AGENT MODE still works (user_code returned; no email) ----
  log("\n[4] spec-pure agent mode (claim_delivery=agent)");
  const e4 = `raf+qa-b9-agent-${TS}@kernel.sh`;
  const reg4 = await jpost("/agent/identity", { type: "service_auth", login_hint: e4, claim_delivery: "agent" });
  ok(reg4.status === 200 && reg4.json?.claim?.delivery === "agent", "agent-mode register delivery=agent", reg4.json?.claim);
  ok(/^[0-9]{6}$/.test(reg4.json?.claim?.user_code || ""), "agent mode RETURNS user_code", reg4.json?.claim?.user_code);
  ok(typeof reg4.json?.claim?.verification_uri === "string", "agent mode returns verification_uri");
  const ce4 = await qaClaimEmail(e4);
  ok(ce4.status === 404, "agent mode sends NO claim email (QA lookup 404)", ce4.status);
  // read-back endpoint refuses agent-mode registrations.
  const wrongMode = await jpost("/agent/identity/claim/complete", { claim_token: reg4.json.claim_token, user_code: reg4.json.claim.user_code });
  ok(wrongMode.status === 409 && wrongMode.json?.error === "wrong_delivery_mode", "read-back on agent-mode -> 409 wrong_delivery_mode", wrongMode.json);

  // Complete agent mode via the hosted /claim form (login -> claim).
  const nextPath = new URL(reg4.json.claim.verification_uri).searchParams.get("next");
  const attemptTok = new URLSearchParams(nextPath.split("?")[1]).get("claim_attempt_token");
  // Claim-aware /login copy:
  const loginPage = await getHtml(`/login?next=${encodeURIComponent(nextPath)}`);
  ok(/registering a justhtml\.sh account for/.test(loginPage.text), "claim-aware /login copy present", loginPage.status);
  ok(loginPage.text.includes(e4), "claim /login copy names the email");
  ok(!/This never creates an account/.test(loginPage.text), "claim /login DROPS the contradictory 'never creates an account' line");
  // Sign in via QA login link.
  await form("/login", { email: e4, next: nextPath });
  const ll = await fetch(`${BASE}/internal/qa/latest-login-link?email=${encodeURIComponent(e4)}`, { headers: { "X-QA-Secret": QA } });
  const llj = await ll.json();
  const lv = new URL(llj.link);
  const verify = await form("/login/verify", { token: lv.searchParams.get("token"), next: lv.searchParams.get("next") });
  const cookie = (verify.res.headers.get("set-cookie") || "").split(";")[0];
  // Claim form copy says an account is being created.
  const claimForm = await getHtml(`/claim?claim_attempt_token=${attemptTok}`, { Cookie: cookie });
  ok(/creating a justhtml\.sh account/.test(claimForm.text), "/claim form says an account is being created", claimForm.status);
  const claimSubmitRes = await fetch(BASE + "/claim", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: BASE, Cookie: cookie },
    body: new URLSearchParams({ claim_attempt_token: attemptTok, user_code: reg4.json.claim.user_code }).toString(),
    redirect: "manual",
  });
  const claimSubmitText = await claimSubmitRes.text();
  ok(claimSubmitRes.status === 200 && /ALL SET/.test(claimSubmitText), "claim form submit ok", claimSubmitRes.status);
  const key4 = await pollToken(reg4.json.claim_token);
  ok(key4?.startsWith("jh_live_"), "agent-mode poll returns key after form submit", key4?.slice(0, 12));

  // ---- 5. bad claim_delivery rejected ----
  log("\n[5] validation");
  const bad = await jpost("/agent/identity", { type: "service_auth", login_hint: `raf+qa-b9-bad-${TS}@kernel.sh`, claim_delivery: "carrier_pigeon" });
  ok(bad.status === 400 && bad.json?.error === "invalid_request", "bad claim_delivery -> 400", bad.json);

  log(`\n==== B9 QA: ${PASS} passed, ${FAIL} failed ====`);
  process.exit(FAIL ? 1 : 0);
}

main().catch((e) => { console.error("FATAL", e); process.exit(2); });
