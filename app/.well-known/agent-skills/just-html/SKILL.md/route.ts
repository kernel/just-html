import { SKILL_MARKDOWN } from "@/lib/skill-content";

export const dynamic = "force-static";

export function GET(): Response {
  return new Response(SKILL_MARKDOWN, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
