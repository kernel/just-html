import { Resend } from "resend";
import {
  RESEND_FROM,
  LOGIN_SUBJECT,
  LOGIN_TOKEN_TTL_S,
  SHARE_TOKEN_TTL_S,
} from "@/lib/auth/config";

// justhtml.sh sends exactly two kinds of email, both handwritten man-page-style
// HTML, inline styles only (clients strip <style>), no images, no tracking
// pixels, no template framework. A matching text/plain part rides alongside.
//   1. the login magic link (§9.5)
//   2. the share notification (birthday.md "Share notifications") — sent when an
//      owner creates an email grant; carries a single 7-day login+redirect link.

let client: Resend | null = null;
function resend(): Resend {
  if (!client) client = new Resend(process.env.RESEND_API_KEY);
  return client;
}

const EXPIRY_MIN = Math.round(LOGIN_TOKEN_TTL_S / 60);

function htmlBody(email: string, link: string, date: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const e = esc(email);
  const href = esc(link);
  return `<!doctype html>
<html>
  <body style="margin:0; padding:24px; background:#ffffff;">
    <pre style="margin:0; font-family:ui-monospace,Menlo,Consolas,'Courier New',monospace; font-size:13px; line-height:1.5; color:#111111; white-space:pre-wrap;">
JUSTHTML.SH(1)                     LOGIN                     JUSTHTML.SH(1)

NAME
    justhtml.sh login link

SYNOPSIS
    you (or your agent's claim ceremony) asked to sign in as
    ${e}

LINK
    <a href="${href}" style="color:#0000ee;">${href}</a>

NOTES
    single use. expires in ${EXPIRY_MIN} minutes.

    clicking signs you in on this device. if a claim ceremony is in
    progress you'll land on the code form — type the 6-digit code
    your agent showed you.

    didn't request this? ignore it. nothing happens without the
    click, and this link creates no account by itself.

JUSTHTML.SH                      ${date}                  JUSTHTML.SH(1)
    </pre>
  </body>
</html>`;
}

function textBody(email: string, link: string): string {
  return `justhtml.sh login link

you (or your agent's claim ceremony) asked to sign in as ${email}

LINK
  ${link}

single use. expires in ${EXPIRY_MIN} minutes. clicking signs you in on this
device; if a claim ceremony is in progress you'll land on the code form —
type the 6-digit code your agent showed you.

didn't request this? ignore it. nothing happens without the click, and this
link creates no account by itself.`;
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
  granteeEmail: string;
  date: string;
}): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const owner = esc(opts.ownerEmail);
  const title = esc(opts.title);
  const grantee = esc(opts.granteeEmail);
  const href = esc(opts.link);
  const docHref = esc(opts.docUrl);
  return `<!doctype html>
<html>
  <body style="margin:0; padding:24px; background:#ffffff;">
    <pre style="margin:0; font-family:ui-monospace,Menlo,Consolas,'Courier New',monospace; font-size:13px; line-height:1.5; color:#111111; white-space:pre-wrap;">
JUSTHTML.SH(1)                     SHARE                     JUSTHTML.SH(1)

NAME
    a document was shared with you

SYNOPSIS
    ${owner} shared the document
    "${title}" with ${grantee}.

OPEN
    <a href="${href}" style="color:#0000ee;">${href}</a>

NOTES
    clicking the link signs you in on this device and takes you
    straight to the document. no account or password needed.

    single use. expires in ${SHARE_EXPIRY_DAYS} days. if it expires, open the
    document directly and choose "was this shared with you? sign in":
    <a href="${docHref}" style="color:#0000ee;">${docHref}</a>

    to edit via API, tell your agent to register at
    justhtml.sh/auth.md with this email.

    didn't expect this? you can ignore it — nothing happens
    without the click.

JUSTHTML.SH                      ${opts.date}                  JUSTHTML.SH(1)
    </pre>
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
  return `${opts.ownerEmail} shared a document with you on justhtml.sh

"${opts.title}" was shared with ${opts.granteeEmail}.

OPEN
  ${opts.link}

clicking the link signs you in on this device and takes you straight to the
document. no account or password needed. single use, expires in ${SHARE_EXPIRY_DAYS} days.
if it expires, open the document directly and choose "was this shared with you?
sign in":
  ${opts.docUrl}

to edit via API, tell your agent to register at justhtml.sh/auth.md with this
email.

didn't expect this? you can ignore it — nothing happens without the click.`;
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
