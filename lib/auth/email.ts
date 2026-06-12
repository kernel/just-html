import { Resend } from "resend";
import { RESEND_FROM, LOGIN_SUBJECT, LOGIN_TOKEN_TTL_S } from "@/lib/auth/config";

// The only email justhtml.sh sends: the login magic link (§9.5). Handwritten
// man-page-style HTML, inline styles only (clients strip <style>), no images,
// no tracking pixels, no template framework. A matching text/plain part rides
// alongside.

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
