import { createHash } from "node:crypto";

import { ORIGIN } from "@/lib/auth/config";
import {
  SKILL_DESCRIPTION,
  SKILL_MARKDOWN,
  SKILL_NAME,
} from "@/lib/skill-content";

export const dynamic = "force-static";

const digest = createHash("sha256").update(SKILL_MARKDOWN).digest("hex");
const BODY = JSON.stringify({
  $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
  skills: [
    {
      name: SKILL_NAME,
      type: "skill-md",
      description: SKILL_DESCRIPTION,
      url: `${ORIGIN}/.well-known/agent-skills/${SKILL_NAME}/SKILL.md`,
      digest: `sha256:${digest}`,
    },
  ],
});

export function GET(): Response {
  return new Response(BODY, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
