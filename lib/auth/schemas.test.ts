import { describe, it, expect } from "vitest";
import yaml from "js-yaml";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { OpenApiGeneratorV31 } from "@asteasolutions/zod-to-openapi";
import { registry } from "@/lib/openapi/registry";
// Side-effecting: populate the registry with every resource's paths (docs Z1–Z3
// + auth Z4) exactly as scripts/gen-spec.ts does.
import "@/lib/docs/schemas";
import "@/lib/docs/paths";
import "@/lib/auth/schemas";
import "@/lib/auth/paths";

// The Zod registry must cover the WHOLE served surface, including the agent
// ceremony, OAuth, and the .well-known discovery docs. Since the Z5 cutover the
// served spec IS the generated one (lib/openapi/generated-spec.ts), so these
// pins guard that the registry keeps modelling the full auth surface — and that
// /oauth2/* stays form-encoded — independent of the committed artifact.

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const HTTP_METHODS = ["get", "post", "put", "patch", "delete"];

function endpointSet(doc: { paths?: Record<string, Record<string, unknown>> }): Set<string> {
  const out = new Set<string>();
  for (const [path, ops] of Object.entries(doc.paths ?? {})) {
    for (const k of Object.keys(ops)) {
      if (HTTP_METHODS.includes(k.toLowerCase())) out.add(`${k.toUpperCase()} ${path}`);
    }
  }
  return out;
}

// The committed served artifact (the bytes GET /api/spec.yaml returns).
function servedDoc() {
  const src = readFileSync(join(ROOT, "lib/openapi/generated-spec.ts"), "utf8");
  const m = src.match(/export const SPEC_YAML = (".*");\n?$/s);
  if (!m) throw new Error("could not find SPEC_YAML in generated-spec.ts");
  return yaml.load(JSON.parse(m[1])) as { paths?: Record<string, Record<string, unknown>> };
}

function generatedDoc() {
  const generator = new OpenApiGeneratorV31(registry.definitions);
  return generator.generateDocument({
    openapi: "3.1.0",
    info: { title: "t", version: "1.0.0" },
  }) as { paths?: Record<string, Record<string, unknown>> };
}

describe("Zod registry covers 100% of the served spec's paths", () => {
  it("freshly generated path+method set equals the committed served artifact's set", () => {
    const served = endpointSet(servedDoc());
    const gen = endpointSet(generatedDoc());
    const onlyServed = [...served].filter((x) => !gen.has(x)).sort();
    const onlyGen = [...gen].filter((x) => !served.has(x)).sort();
    expect({ onlyServed, onlyGen }).toEqual({ onlyServed: [], onlyGen: [] });
  });

  it("includes the agent ceremony, OAuth, and .well-known paths", () => {
    const gen = endpointSet(generatedDoc());
    for (const e of [
      "POST /agent/identity",
      "POST /agent/identity/claim",
      "POST /agent/identity/claim/complete",
      "POST /oauth2/token",
      "POST /oauth2/revoke",
      "GET /.well-known/oauth-protected-resource",
      "GET /.well-known/oauth-authorization-server",
    ]) {
      expect(gen.has(e), `missing ${e}`).toBe(true);
    }
  });

  it("models /oauth2/* request bodies as form-urlencoded (not JSON)", () => {
    const gen = generatedDoc() as {
      paths?: Record<string, Record<string, { requestBody?: { content?: Record<string, unknown> } }>>;
    };
    for (const p of ["/oauth2/token", "/oauth2/revoke"]) {
      const content = gen.paths?.[p]?.post?.requestBody?.content ?? {};
      expect(Object.keys(content), `${p} content types`).toEqual(["application/x-www-form-urlencoded"]);
    }
  });
});
