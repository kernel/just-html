import { Resend } from "resend";
import {
  RESEND_FROM,
  LOGIN_SUBJECT,
  CLAIM_SUBJECT,
  LOGIN_TOKEN_TTL_MIN,
  USER_CODE_TTL_MIN,
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
//
// Variant B (ultra-spare), LOCKED 2026-06-13. SPACING (revised 2026-06-13 after
// the first send looked wildly over-spaced in Superhuman + airy in Gmail):
// vertical rhythm is fixed-height table SPACER ROWS, never div margins — some
// clients (Superhuman) amplify margins between stacked block elements, which is
// what blew the gaps out. Tight line-height, modest type. color-scheme:light
// hints clients not to dark-invert.

let client: Resend | null = null;
function resend(): Resend {
  if (!client) client = new Resend(process.env.RESEND_API_KEY);
  return client;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const FONT = "font-family:ui-monospace,Menlo,Consolas,'Courier New',monospace;";
const LEAD = `${FONT} font-size:14px; line-height:1.5; color:#111111;`;
const CAVEAT = `${FONT} font-size:13px; line-height:1.5; color:#666666;`;
const CODE = `${FONT} font-size:34px; font-weight:700; letter-spacing:0.18em; line-height:1; color:#111111;`;
const LINK = "color:#0000ee; font-size:15px;";

// Bulletproof fixed-height spacer — a table row clients can't collapse or
// amplify (font-size:1px + matching line-height/height keeps it exact).
function gap(px: number): string {
  return `<tr><td style="height:${px}px; line-height:${px}px; font-size:1px;">&nbsp;</td></tr>`;
}

// Email shell: light-only, left-aligned, max 600px, content laid out as table
// rows so spacing is exact across clients.
function shell(title: string, rows: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light">
<title>${title}</title>
</head>
<body style="margin:0; padding:0; background:#ffffff; color-scheme:light only;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#ffffff;">
<tr><td align="left">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;">
<tr><td style="padding:28px 24px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
${rows}
</table>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

const EXPIRY_MIN = LOGIN_TOKEN_TTL_MIN;

function htmlBody(email: string, link: string): string {
  const rows = `<tr><td style="${LEAD}">Sign in to justhtml.sh as <strong>${esc(email)}</strong>.</td></tr>
${gap(16)}<tr><td style="${LEAD}"><a href="${esc(link)}" style="${LINK}">Click here to sign in &rarr;</a></td></tr>
${gap(16)}<tr><td style="${CAVEAT}">Single use, expires in ${EXPIRY_MIN} minutes. Didn't ask for this? Ignore it.</td></tr>`;
  return shell("justhtml.sh login", rows);
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
export async function sendLoginEmail(
  email: string,
  link: string,
  idempotencyKey: string
): Promise<string | null> {
  const { data, error } = await resend().emails.send(
    {
      from: RESEND_FROM,
      to: email,
      subject: LOGIN_SUBJECT,
      html: htmlBody(email, link),
      text: textBody(email, link),
      tags: [{ name: "flow", value: "login_link" }],
    },
    { idempotencyKey }
  );
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

const CLAIM_EXPIRY_MIN = USER_CODE_TTL_MIN;

function claimHtmlBody(opts: { email: string; code: string }): string {
  const rows = `<tr><td style="${LEAD}">Your justhtml.sh code for ${esc(opts.email)}:</td></tr>
${gap(18)}<tr><td style="${CODE}">${esc(opts.code)}</td></tr>
${gap(18)}<tr><td style="${CAVEAT}">Read it back to the agent registering you. Expires in ${CLAIM_EXPIRY_MIN} minutes. Didn't expect this? Ignore it.</td></tr>`;
  return shell("your justhtml.sh code", rows);
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
  idempotencyKey: string;
}): Promise<string | null> {
  const { data, error } = await resend().emails.send(
    {
      from: RESEND_FROM,
      to: opts.to,
      subject: CLAIM_SUBJECT,
      html: claimHtmlBody({ email: opts.to, code: opts.code }),
      text: claimTextBody({ email: opts.to, code: opts.code }),
      tags: [{ name: "flow", value: "claim_email" }],
    },
    { idempotencyKey: opts.idempotencyKey }
  );
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

function shareHtmlBody(opts: {
  ownerEmail: string;
  title: string;
  link: string;
  docUrl: string;
}): string {
  const rows = `<tr><td style="${LEAD}">${esc(opts.ownerEmail)} shared <strong>"${esc(opts.title)}"</strong> with you.</td></tr>
${gap(16)}<tr><td style="${LEAD}"><a href="${esc(opts.link)}" style="${LINK}">Open the document &rarr;</a></td></tr>
${gap(16)}<tr><td style="${CAVEAT}">Signs you in on this device, no account needed. Good for ${SHARE_EXPIRY_DAYS} days. If it expires, <a href="${esc(opts.docUrl)}" style="color:#666666;">open the document</a> and choose "was this shared with you? sign in". To edit via API, have your agent register at justhtml.sh/auth.md with this email.</td></tr>`;
  return shell("shared with you on justhtml.sh", rows);
}

function shareTextBody(opts: {
  ownerEmail: string;
  title: string;
  link: string;
  docUrl: string;
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
  idempotencyKey: string;
}): Promise<string | null> {
  const { data, error } = await resend().emails.send(
    {
      from: RESEND_FROM,
      to: opts.to,
      subject: shareSubject(opts.ownerEmail, opts.title),
      html: shareHtmlBody({
        ownerEmail: opts.ownerEmail,
        title: opts.title,
        link: opts.link,
        docUrl: opts.docUrl,
      }),
      text: shareTextBody({
        ownerEmail: opts.ownerEmail,
        title: opts.title,
        link: opts.link,
        docUrl: opts.docUrl,
      }),
      tags: [{ name: "flow", value: "share_notification" }],
    },
    { idempotencyKey: opts.idempotencyKey }
  );
  if (error) {
    throw new Error(`resend send failed: ${error.message ?? String(error)}`);
  }
  return data?.id ?? null;
}
