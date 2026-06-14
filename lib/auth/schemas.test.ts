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

// Z4 acceptance criterion: after registering the agent ceremony, OAuth, and the
// .well-known discovery docs, the Zod registry covers EVERY path+method the served
// hand-written spec documents. This pins generated-set == hand-written-set so the
// auth surface can't silently drift before the Z5 cutover.

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

function handWrittenDoc() {
  const src = readFileSync(join(ROOT, "lib/openapi/spec-yaml.ts"), "utf8");
  const m = src.match(/export const SPEC_YAML = `([\s\S]*?)`;/);
  if (!m) throw new Error("could not find SPEC_YAML");
  return yaml.load(m[1]) as { paths?: Record<string, Record<string, unknown>> };
}

function generatedDoc() {
  const generator = new OpenApiGeneratorV31(registry.definitions);
  return generator.generateDocument({
    openapi: "3.1.0",
    info: { title: "t", version: "1.0.0" },
  }) as { paths?: Record<string, Record<string, unknown>> };
}

describe("Z4 — Zod registry covers 100% of the served spec's paths", () => {
  it("generated path+method set equals the hand-written spec's set", () => {
    const hand = endpointSet(handWrittenDoc());
    const gen = endpointSet(generatedDoc());
    const onlyHand = [...hand].filter((x) => !gen.has(x)).sort();
    const onlyGen = [...gen].filter((x) => !hand.has(x)).sort();
    expect({ onlyHand, onlyGen }).toEqual({ onlyHand: [], onlyGen: [] });
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
