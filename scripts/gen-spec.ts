// scripts/gen-spec.ts — code-first OpenAPI generation. Runs the
// OpenApiGeneratorV31 over the shared registry (populated by importing each
// resource's schemas + paths modules) and writes the SERVED spec artifact.
//
// Z5 (cutover): the generated spec IS now what GET /api/spec.yaml serves. The
// hand-written literal is gone. `npm run gen:spec` writes two committed
// artifacts from the SAME document:
//   - lib/openapi/generated-spec.ts — `export const SPEC_YAML = ...`, imported
//     by the route (mirrors how gen-skill commits SKILL.md). This is the bytes
//     served in production.
//   - lib/openapi/generated.yaml     — the same YAML as a plain file, for
//     out-of-band validation (@redocly/cli) and human diffing.
// scripts/spec-check.ts re-runs this generator and asserts the committed
// artifacts match it byte-for-byte, so the served spec can never drift from the
// Zod schemas (the spec-sync GitHub Action regenerates + commits on change).

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { OpenApiGeneratorV31 } from "@asteasolutions/zod-to-openapi";

import { registry } from "../lib/openapi/registry";
// Side-effecting imports: registering each resource's schemas + paths into the
// shared registry. Docs (Z1–Z3) + the auth surface (Z4: the agent ceremony,
// OAuth token/revoke, and the .well-known discovery docs).
import "../lib/docs/schemas";
import "../lib/docs/paths";
import "../lib/auth/schemas";
import "../lib/auth/paths";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const YAML_OUT = join(ROOT, "lib/openapi/generated.yaml");
const TS_OUT = join(ROOT, "lib/openapi/generated-spec.ts");

// Document-level metadata the generator does not derive from schemas/paths. These
// carry over verbatim from the (now-deleted) hand-written spec so the served spec
// is equivalent-or-richer: the rich info block + license, the tag catalogue with
// descriptions, the production server, and the document-wide default security
// (bearerApiKey). Per-operation `security` overrides this default (the auth +
// discovery surfaces set `security: []`; the collaboration reads set the
// `[bearerApiKey] OR anonymous` pair) — see lib/*/paths.ts.
const TAGS = [
  { name: "auth", description: "auth.md service_auth registration + OAuth token/revoke" },
  { name: "discovery", description: "Machine-readable OAuth discovery metadata" },
  { name: "docs", description: "Document CRUD, patch editing, versions" },
  { name: "sharing", description: "Per-document grants (email or domain)" },
  {
    name: "collaboration",
    description: "Comments (W3C text-quote anchors, 1-level threads) and reactions",
  },
];

export function generateSpec(): Record<string, unknown> {
  const generator = new OpenApiGeneratorV31(registry.definitions);
  return generator.generateDocument({
    openapi: "3.1.0",
    info: {
      title: "justhtml.sh API",
      version: "1.0.0",
      description:
        "An agent-first minimal HTML document host. Agents self-onboard via the\n" +
        "auth.md service_auth flow (see https://justhtml.sh/auth.md), receive a\n" +
        "long-lived API key, and publish HTML documents to stable URLs.\n\n" +
        "Terse usage with curl examples: https://justhtml.sh/llms.txt\n",
      license: { name: "Proprietary", url: "https://justhtml.sh/" },
    },
    servers: [{ url: "https://justhtml.sh", description: "Production" }],
    tags: TAGS,
    security: [{ bearerApiKey: [] }],
  }) as unknown as Record<string, unknown>;
}

/** The exact YAML bytes served by GET /api/spec.yaml and validated by redocly. */
export function generateSpecYaml(): string {
  return yaml.dump(generateSpec(), { lineWidth: 100, noRefs: true });
}

/** The committed .ts artifact the route imports (mirrors gen-skill's SKILL.md). */
export function generatedSpecModule(specYaml: string): string {
  return (
    "// GENERATED FILE — do not edit by hand. Run `npm run gen:spec` to regenerate.\n" +
    "//\n" +
    "// Code-first OpenAPI 3.1 spec for justhtml.sh, produced by scripts/gen-spec.ts\n" +
    "// from the Zod schemas + paths registered in lib/{docs,auth}/{schemas,paths}.ts.\n" +
    "// This is the SOURCE OF TRUTH the app/api/spec.yaml route serves verbatim and\n" +
    "// the e2e response-schema validator reads. scripts/spec-check.ts asserts this\n" +
    "// committed artifact matches a fresh generation, so it can never drift.\n" +
    "\n" +
    "export const SPEC_YAML = " +
    JSON.stringify(specYaml) +
    ";\n"
  );
}

function main() {
  const specYaml = generateSpecYaml();
  writeFileSync(YAML_OUT, specYaml);
  writeFileSync(TS_OUT, generatedSpecModule(specYaml));
  const paths = Object.keys(
    (yaml.load(specYaml) as { paths?: Record<string, unknown> }).paths ?? {}
  );
  console.log(
    `wrote ${YAML_OUT} + ${TS_OUT} (${specYaml.length} bytes, ${paths.length} paths)`
  );
}

// Run when invoked directly (not when imported by spec-check).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
