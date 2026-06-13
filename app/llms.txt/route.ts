// GET /llms.txt — terse, agent-facing usage doc. Plain text. Zero JS.
//
// Served as a route handler (new Response(text)) per the brand rule: every
// surface that can be plain text/HTML IS, off a handler. Mirrors the same
// technique as /auth.md and /api/spec.yaml. force-dynamic keeps it a real
// handler response (see note in app/route.ts on why we avoid force-static).
//
// CONTENT lives in lib/skill-content.mjs (the single source of truth), shared
// with skills/just-html/SKILL.md so `npx skills add kernel/just-html` and
// /llms.txt never drift. Edit the content there, not here.
import { LLMS_BODY } from "@/lib/skill-content.mjs";

export const dynamic = "force-dynamic";

export function GET() {
  return new Response(LLMS_BODY, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}
