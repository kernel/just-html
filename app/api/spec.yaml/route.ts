// GET /api/spec.yaml — OpenAPI 3.1 covering every v1 endpoint plus the auth.md /
// OAuth surfaces. Served as a route handler (new Response(text)).
//
// Z5 cutover: this is now the CODE-FIRST generated spec. The bytes come from
// lib/openapi/generated-spec.ts, a committed artifact `npm run gen:spec` produces
// from the Zod schemas + paths in lib/{docs,auth}/{schemas,paths}.ts (mirrors how
// gen-skill commits SKILL.md from lib/skill-content.ts). scripts/spec-check.ts
// asserts this artifact matches a fresh generation, so the served spec can never
// drift from the schemas; the hand-written literal that used to live here is gone.
// Validated locally with @redocly/cli before ship.
import { SPEC_YAML } from "@/lib/openapi/generated-spec";

export const dynamic = "force-dynamic";

export function GET() {
  return new Response(SPEC_YAML, {
    status: 200,
    headers: {
      "Content-Type": "application/yaml; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}
