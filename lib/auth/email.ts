import { Resend } from "resend";
import {
  RESEND_FROM,
  LOGIN_SUBJECT,
  CLAIM_SUBJECT,
  LOGIN_TOKEN_TTL_S,
  USER_CODE_TTL_S,
  SHARE_TOKEN_TTL_S,
} from "@/lib/auth/config";

// justhtml.sh sends three kinds of email, all handwritten man-page-style HTML,
// inline styles only (clients strip <style>), no images, no tracking pixels, no
// template framework. A matching text/plain part rides alongside.
//   1. the login magic link (§9.5)
//   2. the share notification (birthday.md "Share notifications") — sent when an
//      owner creates an email grant; carries a single 7-day login+redirect link.
//   3. the claim email (the ONE claim flow) — carries the 6-digit code and
//      NOTHING else actionable (no links, no buttons). The human reads the code
//      back to the agent. Binding proof = inbox possession.

let client: Resend | null = null;
function resend(): Resend {
  if (!client) client = new Resend(process.env.RESEND_API_KEY);
  return client;
}

const EXPIRY_MIN = Math.round(LOGIN_TOKEN_TTL_S / 60);

// Variant B (ultra-spare), LOCKED 2026-06-13. One sentence + the single
// load-bearing thing (the link) + one quiet caveat line. Inline CSS only (no
// <style>), no images, no tracking pixels, light only, ~600px.
function htmlBody(email: string, link: string, _date: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const e = esc(email);
  const href = esc(link);
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>justhtml.sh login</title></head>
<body style="margin:0; padding:0; background:#ffffff;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#ffffff;">
  <tr><td align="left">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;">
  <tr><td style="padding:40px 24px;">
    <div style="font-family:ui-monospace,Menlo,Consolas,'Courier New',monospace; font-size:13px; line-height:1.7; color:#111111;">
      <div>Sign in to justhtml.sh as <strong>${e}</strong>.</div>
      <div style="margin-top:24px;"><a href="${href}" style="color:#0000ee; font-size:15px;">Click here to sign in &rarr;</a></div>
      <div style="margin-top:24px; color:#666666;">Single use, expires in ${EXPIRY_MIN} minutes. Didn't ask for this? Ignore it.</div>
    </div>
  </td></tr>
  </table>
  </td></tr>
  </table>
</body>
</html>`;
}

function textBody(email: string, link: string): string {
  return `Sign in to justhtml.sh as ${email}.

Click here to sign in:
  ${link}

Single use, expires in ${EXPIRY_MIN} minutes. Didn't ask for this? Ignore it.`;
}

/**
 * Send the login magic link. Returns the Resend message id on success.
 * Throws on send failure so the caller can roll back the token row (§9.2 step 6).
 */
export async function sendLoginEmail(email: string, link: string): Promise<string | null> {
  const date = new Date().toISOString().slice(0, 10);
  const { data, error } = await resend().emails.send({
    from: RESEND_FROM,
    to: email,
    subject: LOGIN_SUBJECT,
    html: htmlBody(email, link, date),
    text: textBody(email, link),
    tags: [{ name: "flow", value: "login_link" }],
  });
  if (error) {
    throw new Error(`resend send failed: ${error.message ?? String(error)}`);
  }
  return data?.id ?? null;
}

// --- Claim email (the ONE claim flow) ---
//
// Carries the 6-digit code and NOTHING else actionable: no links, no buttons.
// The human reads the code back to the agent, which submits it to
// /agent/identity/claim/complete. Binding proof = inbox possession.

const CLAIM_EXPIRY_MIN = Math.round(USER_CODE_TTL_S / 60);

// Variant B (ultra-spare), LOCKED 2026-06-13. NO links — the 6-digit code is the
// anchor: big and centered. One lead sentence + the code + one quiet caveat line.
function claimHtmlBody(opts: { email: string; code: string; date: string }): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const e = esc(opts.email);
  const code = esc(opts.code);
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>your justhtml.sh code</title></head>
<body style="margin:0; padding:0; background:#ffffff;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#ffffff;">
  <tr><td align="left">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;">
  <tr><td style="padding:40px 24px;">
    <div style="font-family:ui-monospace,Menlo,Consolas,'Courier New',monospace; font-size:13px; line-height:1.7; color:#111111;">
      <div>Your justhtml.sh code for ${e}:</div>
      <div style="margin:24px 0; font-size:48px; font-weight:700; letter-spacing:0.4em; line-height:1;">${code}</div>
      <div style="color:#666666;">Read it back to the agent registering you. Expires in ${CLAIM_EXPIRY_MIN} minutes. Didn't expect this? Ignore it.</div>
    </div>
  </td></tr>
  </table>
  </td></tr>
  </table>
</body>
</html>`;
}

function claimTextBody(opts: { email: string; code: string }): string {
  return `Your justhtml.sh code for ${opts.email}:

  ${opts.code}

Read it back to the agent registering you. Expires in ${CLAIM_EXPIRY_MIN} minutes.
Didn't expect this? Ignore it.`;
}

/**
 * Send the claim email — the 6-digit code, nothing else actionable. Returns the
 * Resend message id; throws on send failure so the caller can fail the
 * registration cleanly (the registration is voided / not surfaced).
 */
export async function sendClaimEmail(opts: {
  to: string;
  code: string;
}): Promise<string | null> {
  const date = new Date().toISOString().slice(0, 10);
  const { data, error } = await resend().emails.send({
    from: RESEND_FROM,
    to: opts.to,
    subject: CLAIM_SUBJECT,
    html: claimHtmlBody({ email: opts.to, code: opts.code, date }),
    text: claimTextBody({ email: opts.to, code: opts.code }),
    tags: [{ name: "flow", value: "claim_email" }],
  });
  if (error) {
    throw new Error(`resend send failed: ${error.message ?? String(error)}`);
  }
  return data?.id ?? null;
}

// --- Share notification (birthday.md "Share notifications: the non-user grantee story") ---

const SHARE_EXPIRY_DAYS = Math.round(SHARE_TOKEN_TTL_S / 86_400);

/** Subject line: `<owner email> shared "<title>" with you — justhtml.sh`. */
export function shareSubject(ownerEmail: string, title: string): string {
  return `${ownerEmail} shared "${title}" with you — justhtml.sh`;
}

// Variant B (ultra-spare), LOCKED 2026-06-13. One sentence + the single 7-day
// link + one quiet caveat line. The stale-link recovery URL and the agent-edit
// path stay folded into the caveat (no links dropped) but compressed to one line.
function shareHtmlBody(opts: {
  ownerEmail: string;
  title: string;
  link: string;
  docUrl: string;
  granteeEmail: string;
  date: string;
}): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const owner = esc(opts.ownerEmail);
  const title = esc(opts.title);
  const href = esc(opts.link);
  const docHref = esc(opts.docUrl);
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>shared with you on justhtml.sh</title></head>
<body style="margin:0; padding:0; background:#ffffff;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#ffffff;">
  <tr><td align="left">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;">
  <tr><td style="padding:40px 24px;">
    <div style="font-family:ui-monospace,Menlo,Consolas,'Courier New',monospace; font-size:13px; line-height:1.7; color:#111111;">
      <div>${owner} shared <strong>"${title}"</strong> with you.</div>
      <div style="margin-top:24px;"><a href="${href}" style="color:#0000ee; font-size:15px;">Open the document &rarr;</a></div>
      <div style="margin-top:24px; color:#666666;">Signs you in on this device, no account needed. Good for ${SHARE_EXPIRY_DAYS} days. If it expires, <a href="${docHref}" style="color:#666666;">open the document</a> and choose "was this shared with you? sign in". To edit via API, have your agent register at justhtml.sh/auth.md with this email.</div>
    </div>
  </td></tr>
  </table>
  </td></tr>
  </table>
</body>
</html>`;
}

function shareTextBody(opts: {
  ownerEmail: string;
  title: string;
  link: string;
  docUrl: string;
  granteeEmail: string;
}): string {
  return `${opts.ownerEmail} shared "${opts.title}" with you on justhtml.sh.

Open the document:
  ${opts.link}

Signs you in on this device, no account needed. Good for ${SHARE_EXPIRY_DAYS} days. If it
expires, open the document directly and choose "was this shared with you? sign in":
  ${opts.docUrl}

To edit via API, have your agent register at justhtml.sh/auth.md with this email.`;
}

/**
 * Send a share-notification email to an email grantee. Returns the Resend
 * message id on success, or throws on send failure (the caller logs but does
 * NOT fail the grant — the grant is already committed; the stale-link fallback
 * on /d/:slug covers a missed email).
 */
export async function sendShareEmail(opts: {
  to: string;
  ownerEmail: string;
  title: string;
  link: string;
  docUrl: string; // bare https://justhtml.sh/d/:slug — the stale-link recovery target
}): Promise<string | null> {
  const date = new Date().toISOString().slice(0, 10);
  const { data, error } = await resend().emails.send({
    from: RESEND_FROM,
    to: opts.to,
    subject: shareSubject(opts.ownerEmail, opts.title),
    html: shareHtmlBody({
      ownerEmail: opts.ownerEmail,
      title: opts.title,
      link: opts.link,
      docUrl: opts.docUrl,
      granteeEmail: opts.to,
      date,
    }),
    text: shareTextBody({
      ownerEmail: opts.ownerEmail,
      title: opts.title,
      link: opts.link,
      docUrl: opts.docUrl,
      granteeEmail: opts.to,
    }),
    tags: [{ name: "flow", value: "share_notification" }],
  });
  if (error) {
    throw new Error(`resend send failed: ${error.message ?? String(error)}`);
  }
  return data?.id ?? null;
}
