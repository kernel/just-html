// scripts/gen-spec.ts — code-first OpenAPI generation (Z1+). Runs the
// OpenApiGeneratorV31 over the shared registry (populated by importing each
// resource's schemas + paths modules) and writes a PARALLEL generated spec to
// lib/openapi/generated.yaml.
//
// IMPORTANT (migration strategy): this artifact is NOT served yet. The
// app/api/spec.yaml route keeps serving the hand-written lib/openapi/spec-yaml.ts
// until the final cutover (Z5). gen-spec exists so scripts/spec-check.ts can DIFF
// the generated docs paths against the hand-written ones and prove the Zod
// schemas faithfully reproduce the contract. Run via `npm run gen:spec` (tsx).
//
// Only the docs resource is registered so far; later phases add the rest, at
// which point the generated spec becomes complete enough to serve.

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
const OUT = join(ROOT, "lib/openapi/generated.yaml");

export function generateSpec(): Record<string, unknown> {
  const generator = new OpenApiGeneratorV31(registry.definitions);
  return generator.generateDocument({
    openapi: "3.1.0",
    info: {
      title: "justhtml.sh API",
      version: "1.0.0",
      description:
        "Code-first generated spec (Z4 — docs + auth surface). Parallel artifact diffed against the hand-written spec; not yet served.",
    },
    servers: [{ url: "https://justhtml.sh", description: "Production" }],
  }) as unknown as Record<string, unknown>;
}

function main() {
  const doc = generateSpec();
  const out = yaml.dump(doc, { lineWidth: 100, noRefs: true });
  writeFileSync(OUT, out);
  const paths = Object.keys((doc as { paths?: Record<string, unknown> }).paths ?? {});
  console.log(`wrote ${OUT} (${out.length} bytes, ${paths.length} paths)`);
}

// Run when invoked directly (not when imported by spec-check).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
