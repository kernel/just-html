// GET /api/spec.yaml — hand-written OpenAPI 3.1 covering every v1 endpoint plus
// the auth.md / OAuth surfaces. Served as a route handler (new Response(text)).
// Validated locally with @redocly/cli (a Spectral/OpenAPI validator) before ship.
//
// The spec string itself lives in lib/openapi/spec-yaml.ts so tooling
// (scripts/spec-check.ts, the e2e response-schema check) can read the exact same
// bytes. This route's behavior is unchanged: it serves SPEC_YAML verbatim.
import { SPEC_YAML } from "@/lib/openapi/spec-yaml";

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
