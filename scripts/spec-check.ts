// scripts/spec-check.ts — STATIC, no-server consistency check that the three
// places the API surface is described agree with each other. Run via
// `npm run spec:check` (tsx). Z0 of the code-first OpenAPI migration: it stops
// the drift bleeding before any Zod is introduced.
//
// It asserts a three-way equality of PATHS+METHODS:
//   1. The hand-written OpenAPI spec (lib/openapi/spec-yaml.ts -> SPEC_YAML).
//   2. The actual on-disk Next.js route handlers (app/**/route.ts), restricted
//      to the surfaces the spec documents (/api/v1/docs/**, the /agent + /oauth2
//      auth routes, and the two /.well-known discovery routes).
//   3. The /llms.txt body (lib/skill-content.ts -> LLMS_BODY): every spec path
//      must appear somewhere in the prose endpoint list.
//
// Fails (exit 1) with a readable diff on any mismatch: a documented-but-missing
// route, a route missing from the docs, a method that the spec and the handler
// disagree on, or a spec path absent from llms.txt.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { generateSpec } from "./gen-spec";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const APP_DIR = join(ROOT, "app");

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
type Method = (typeof HTTP_METHODS)[number];

// --- helpers -------------------------------------------------------------

/** Extract a single backtick-delimited `export const NAME = \`...\`` literal. */
function extractTemplateLiteral(file: string, name: string): string {
  const src = readFileSync(file, "utf8");
  const re = new RegExp("export const " + name + " = `([\\s\\S]*?)`;");
  const m = src.match(re);
  if (!m) throw new Error(`could not find \`export const ${name}\` in ${file}`);
  return m[1];
}

function fmtSet(s: Iterable<string>): string {
  const arr = [...s].sort();
  return arr.length ? arr.map((x) => `    ${x}`).join("\n") : "    (none)";
}

// --- 1. spec paths+methods ----------------------------------------------

function loadSpecEndpoints(): Set<string> {
  const specYaml = extractTemplateLiteral(join(ROOT, "lib/openapi/spec-yaml.ts"), "SPEC_YAML");
  const doc = yaml.load(specYaml) as { paths?: Record<string, Record<string, unknown>> };
  if (!doc || typeof doc !== "object" || !doc.paths) {
    throw new Error("spec has no paths");
  }
  const out = new Set<string>();
  for (const [path, ops] of Object.entries(doc.paths)) {
    for (const key of Object.keys(ops)) {
      const m = key.toUpperCase();
      if ((HTTP_METHODS as readonly string[]).includes(m)) out.add(`${m} ${path}`);
    }
  }
  return out;
}

// --- 2. on-disk route handlers ------------------------------------------

// Map an app-relative directory to its OpenAPI-style URL path:
//   api/v1/docs/[slug]/edits -> /api/v1/docs/{slug}/edits
function dirToUrlPath(relDir: string): string {
  const segs = relDir.split("/").filter(Boolean);
  const mapped = segs.map((s) => {
    const dyn = s.match(/^\[(?:\.\.\.)?(.+)\]$/);
    return dyn ? `{${dyn[1]}}` : s;
  });
  return "/" + mapped.join("/");
}

// Only the surfaces the OpenAPI spec is meant to document. Other route.ts files
// (the homepage, /auth.md, /llms.txt, /d/*, /docs, /login, /api/health,
// /api/spec.yaml, the [...path] catch-all) are intentionally NOT in the spec.
function isDocumentedSurface(urlPath: string): boolean {
  if (urlPath.startsWith("/api/v1/")) return true;
  if (urlPath === "/agent/identity" || urlPath.startsWith("/agent/identity/")) return true;
  if (urlPath === "/oauth2/token" || urlPath === "/oauth2/revoke") return true;
  if (urlPath.startsWith("/.well-known/oauth-")) return true;
  return false;
}

function* walkRouteFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* walkRouteFiles(full);
    } else if (entry === "route.ts" || entry === "route.tsx") {
      yield full;
    }
  }
}

function exportedMethods(file: string): Method[] {
  const src = readFileSync(file, "utf8");
  const found: Method[] = [];
  for (const m of HTTP_METHODS) {
    // `export async function GET(` / `export function GET(` /
    // `export const GET = ` — cover the styles Next route handlers use.
    const re = new RegExp(`export\\s+(?:async\\s+)?(?:function\\s+${m}\\b|const\\s+${m}\\s*[:=])`);
    if (re.test(src)) found.push(m);
  }
  return found;
}

function loadRouteEndpoints(): Set<string> {
  const out = new Set<string>();
  for (const file of walkRouteFiles(APP_DIR)) {
    const relDir = relative(APP_DIR, file).replace(/\/route\.tsx?$/, "");
    const urlPath = dirToUrlPath(relDir);
    if (!isDocumentedSurface(urlPath)) continue;
    for (const m of exportedMethods(file)) out.add(`${m} ${urlPath}`);
  }
  return out;
}

// --- 3. llms.txt body ----------------------------------------------------

// A spec path is "documented" in llms.txt if its path shape appears anywhere in
// the body — as a full https://justhtml.sh/api/v1/... URL with a concrete
// example slug, OR (since the body documents the /api/v1 surface relative to the
// "base: https://justhtml.sh/api/v1" header) as a base-relative path with the
// /api/v1 prefix dropped, e.g. POST /docs/:slug/edits. Params may be written as
// :name, {name}, or a concrete example token.
function pathRegex(path: string): RegExp {
  const segs = path.split("/").filter(Boolean);
  const parts = segs.map((s) => {
    if (/^\{.+\}$/.test(s)) {
      // a path param: matches :name, {name}, or a concrete token (e.g. a slug)
      return "(?::[A-Za-z_][A-Za-z0-9_]*|\\{[A-Za-z_][A-Za-z0-9_]*\\}|[A-Za-z0-9][A-Za-z0-9._-]*)";
    }
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  return new RegExp("/" + parts.join("/") + "(?![A-Za-z0-9_-])");
}

function loadLlmsPaths(): { has: (p: string) => boolean } {
  const body = extractTemplateLiteral(join(ROOT, "lib/skill-content.ts"), "LLMS_BODY");
  return {
    has: (specPath: string) => {
      // Try the full path, and (for /api/v1 endpoints) the base-relative form.
      const candidates = [specPath];
      if (specPath.startsWith("/api/v1/")) candidates.push(specPath.slice("/api/v1".length));
      return candidates.some((c) => pathRegex(c).test(body));
    },
  };
}

// --- 4. generated (Zod) vs hand-written docs-path equivalence ------------
//
// Z1: the docs resource has migrated to Zod schemas that GENERATE a parallel
// spec (scripts/gen-spec.ts). The route still serves the hand-written
// lib/openapi/spec-yaml.ts; this sub-step proves the generated docs paths
// reproduce the hand-written CONTRACT so the eventual cutover (Z5) is safe.
//
// Equivalence is checked on the load-bearing shape — not byte-for-byte YAML
// (the generated spec is intentionally richer: more descriptions/examples, an
// accurate nullable title, explicit `required` arrays). For each docs operation
// we compare, after resolving $refs against each doc's own components:
//   - request-body property-name set + required-field set
//   - each documented 2xx success response's property-name set
// A mismatch means the Zod schemas drifted from the documented contract.

type SchemaObj = Record<string, unknown>;
type OpenApiDoc = {
  paths?: Record<string, Record<string, unknown>>;
  components?: { schemas?: Record<string, SchemaObj> };
};

function resolveRef(doc: OpenApiDoc, schema: unknown): SchemaObj {
  let s = schema as SchemaObj;
  // Follow a single-level $ref into components/schemas (our docs schemas don't
  // chain refs more than one deep for the shapes we compare).
  for (let i = 0; i < 10 && s && typeof s.$ref === "string"; i++) {
    const name = (s.$ref as string).split("/").pop()!;
    s = (doc.components?.schemas ?? {})[name] ?? {};
  }
  // allOf: merge member property/required sets (the hand-written error/quota
  // responses use allOf to extend ApiError).
  if (s && Array.isArray(s.allOf)) {
    const merged: SchemaObj = { type: "object", properties: {}, required: [] };
    for (const member of s.allOf as unknown[]) {
      const r = resolveRef(doc, member);
      Object.assign(merged.properties as object, (r.properties as object) ?? {});
      if (Array.isArray(r.required)) {
        (merged.required as string[]).push(...(r.required as string[]));
      }
    }
    return merged;
  }
  return s ?? {};
}

/** {props, required} name-sets for a (possibly $ref/allOf) object schema. */
function shapeOf(doc: OpenApiDoc, schema: unknown): { props: Set<string>; required: Set<string> } {
  const s = resolveRef(doc, schema);
  const props = new Set<string>(Object.keys((s.properties as object) ?? {}));
  const required = new Set<string>(Array.isArray(s.required) ? (s.required as string[]) : []);
  return { props, required };
}

function setEq(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x));
}

function diffSets(label: string, hand: Set<string>, gen: Set<string>): string | null {
  if (setEq(hand, gen)) return null;
  const onlyHand = [...hand].filter((x) => !gen.has(x)).sort();
  const onlyGen = [...gen].filter((x) => !hand.has(x)).sort();
  const bits: string[] = [];
  if (onlyHand.length) bits.push(`only in hand-written: ${onlyHand.join(", ")}`);
  if (onlyGen.length) bits.push(`only in generated: ${onlyGen.join(", ")}`);
  return `${label}: ${bits.join("; ")}`;
}

// The docs operations to prove equivalent, and which body/response shapes carry
// the load-bearing contract.
const DOCS_OPS: {
  path: string;
  method: string;
  body?: boolean;
  bodyRequired?: boolean;
  successCodes: string[];
}[] = [
  { path: "/api/v1/docs", method: "post", body: true, bodyRequired: true, successCodes: ["201"] },
  { path: "/api/v1/docs", method: "get", successCodes: ["200"] },
  { path: "/api/v1/docs/{slug}", method: "get", successCodes: ["200"] },
  { path: "/api/v1/docs/{slug}", method: "patch", body: true, successCodes: ["200"] },
  { path: "/api/v1/docs/{slug}", method: "delete", successCodes: ["200"] },
  // Z2 — docs sub-resources.
  {
    path: "/api/v1/docs/{slug}/edits",
    method: "post",
    body: true,
    bodyRequired: true,
    successCodes: ["200"],
  },
  { path: "/api/v1/docs/{slug}/rotate-token", method: "post", successCodes: ["200"] },
  { path: "/api/v1/docs/{slug}/versions", method: "get", successCodes: ["200"] },
  { path: "/api/v1/docs/{slug}/versions/{n}", method: "get", successCodes: ["200"] },
  { path: "/api/v1/docs/{slug}/grants", method: "get", successCodes: ["200"] },
  {
    path: "/api/v1/docs/{slug}/grants",
    method: "post",
    body: true,
    bodyRequired: true,
    successCodes: ["201", "200"],
  },
  { path: "/api/v1/docs/{slug}/grants/{id}", method: "delete", successCodes: ["200"] },
  // Z3 — comments + reactions.
  { path: "/api/v1/docs/{slug}/comments", method: "get", successCodes: ["200"] },
  {
    path: "/api/v1/docs/{slug}/comments",
    method: "post",
    body: true,
    bodyRequired: true,
    successCodes: ["201"],
  },
  {
    path: "/api/v1/docs/{slug}/comments/{id}",
    method: "patch",
    body: true,
    successCodes: ["200"],
  },
  { path: "/api/v1/docs/{slug}/comments/{id}", method: "delete", successCodes: ["200"] },
  {
    path: "/api/v1/docs/{slug}/reactions",
    method: "post",
    body: true,
    bodyRequired: true,
    successCodes: ["201", "200"],
  },
  { path: "/api/v1/docs/{slug}/reactions/{id}", method: "delete", successCodes: ["200"] },
];

/** PATH+METHOD set of an OpenAPI doc (the keys spec:check compares). */
function endpointSet(doc: OpenApiDoc): Set<string> {
  const out = new Set<string>();
  for (const [path, ops] of Object.entries(doc.paths ?? {})) {
    for (const key of Object.keys(ops)) {
      const m = key.toUpperCase();
      if ((HTTP_METHODS as readonly string[]).includes(m)) out.add(`${m} ${path}`);
    }
  }
  return out;
}

function opSchemas(doc: OpenApiDoc, path: string, method: string) {
  const op = (doc.paths?.[path]?.[method] ?? {}) as Record<string, unknown>;
  const body = (
    (op.requestBody as { content?: Record<string, { schema?: unknown }> })?.content?.[
      "application/json"
    ] ?? {}
  ).schema;
  const responses = (op.responses ?? {}) as Record<string, { content?: Record<string, { schema?: unknown }> }>;
  return { op, body, responses };
}

function checkDocsEquivalence(): string[] {
  const handYaml = extractTemplateLiteral(join(ROOT, "lib/openapi/spec-yaml.ts"), "SPEC_YAML");
  const hand = yaml.load(handYaml) as OpenApiDoc;

  // Import + run the same generator gen-spec uses, so the artifact and the check
  // can never disagree.
  let gen: OpenApiDoc;
  try {
    gen = generateSpec() as OpenApiDoc;
  } catch (e) {
    return [`could not generate the Zod spec for the docs equivalence check: ${(e as Error).message}`];
  }

  const problems: string[] = [];
  for (const spec of DOCS_OPS) {
    const h = opSchemas(hand, spec.path, spec.method);
    const g = opSchemas(gen, spec.path, spec.method);
    const where = `${spec.method.toUpperCase()} ${spec.path}`;

    if (!g.op || Object.keys(g.op).length === 0) {
      problems.push(`${where}: missing from the generated (Zod) spec`);
      continue;
    }

    if (spec.body) {
      if (h.body === undefined || g.body === undefined) {
        problems.push(`${where}: request body present in one spec but not the other`);
      } else {
        const hb = shapeOf(hand, h.body);
        const gb = shapeOf(gen, g.body);
        const dp = diffSets(`${where} request body properties`, hb.props, gb.props);
        if (dp) problems.push(dp);
        if (spec.bodyRequired) {
          const dr = diffSets(`${where} request body required`, hb.required, gb.required);
          if (dr) problems.push(dr);
        }
      }
    }

    for (const code of spec.successCodes) {
      const hs = h.responses[code]?.content?.["application/json"]?.schema;
      const gs = g.responses[code]?.content?.["application/json"]?.schema;
      if (hs === undefined || gs === undefined) {
        problems.push(`${where} ${code}: success response schema present in one spec but not the other`);
        continue;
      }
      const hShape = shapeOf(hand, hs);
      const gShape = shapeOf(gen, gs);
      const dp = diffSets(`${where} ${code} response properties`, hShape.props, gShape.props);
      if (dp) problems.push(dp);
    }
  }
  return problems;
}

// --- 5. generated (Zod) vs hand-written PATH-SET parity ------------------
//
// Z4: the registry now covers EVERY path the served hand-written spec documents
// (docs + the agent ceremony + OAuth + the .well-known discovery docs). This
// asserts the generated path+method set equals the hand-written one, so the Zod
// registry can never silently drift from the served spec's path surface before
// the Z5 cutover (when the generated spec BECOMES what is served).
function checkPathSetParity(): string[] {
  const handYaml = extractTemplateLiteral(join(ROOT, "lib/openapi/spec-yaml.ts"), "SPEC_YAML");
  const hand = yaml.load(handYaml) as OpenApiDoc;
  let gen: OpenApiDoc;
  try {
    gen = generateSpec() as OpenApiDoc;
  } catch (e) {
    return [`could not generate the Zod spec for the path-set parity check: ${(e as Error).message}`];
  }
  const h = endpointSet(hand);
  const g = endpointSet(gen);
  const d = diffSets("generated vs hand-written path set", h, g);
  return d ? [d] : [];
}

// --- assertions ----------------------------------------------------------

function main() {
  const spec = loadSpecEndpoints();
  const routes = loadRouteEndpoints();
  const llms = loadLlmsPaths();

  const problems: string[] = [];

  const documentedButMissing = [...spec].filter((e) => !routes.has(e));
  const missingFromDocs = [...routes].filter((e) => !spec.has(e));

  if (documentedButMissing.length) {
    problems.push(
      "Spec documents endpoints with no matching on-disk route handler:\n" +
        fmtSet(documentedButMissing)
    );
  }
  if (missingFromDocs.length) {
    problems.push(
      "On-disk route handlers not documented in the OpenAPI spec:\n" + fmtSet(missingFromDocs)
    );
  }

  // Every spec PATH (not method) must appear in the llms.txt body.
  const specPaths = new Set([...spec].map((e) => e.split(" ", 2)[1]));
  const absentFromLlms = [...specPaths].filter((p) => !llms.has(p));
  if (absentFromLlms.length) {
    problems.push(
      "Spec paths not referenced anywhere in the /llms.txt body (lib/skill-content.ts):\n" +
        fmtSet(absentFromLlms)
    );
  }

  // Z1: prove the generated (Zod) docs paths reproduce the hand-written contract.
  const docsEquiv = checkDocsEquivalence();
  if (docsEquiv.length) {
    problems.push(
      "Generated (Zod) docs paths are not equivalent to the hand-written spec's docs paths:\n" +
        docsEquiv.map((p) => `    ${p}`).join("\n")
    );
  }

  // Z4: prove the generated (Zod) registry covers exactly the served spec's path set.
  const pathParity = checkPathSetParity();
  if (pathParity.length) {
    problems.push(
      "Generated (Zod) registry path set is not equal to the hand-written spec's path set:\n" +
        pathParity.map((p) => `    ${p}`).join("\n")
    );
  }

  if (problems.length) {
    console.error("spec:check FAILED — the API surface has drifted:\n");
    console.error(problems.join("\n\n"));
    console.error(
      `\nSummary: ${spec.size} spec endpoints, ${routes.size} on-disk route endpoints, ` +
        `${specPaths.size} spec paths.`
    );
    process.exit(1);
  }

  console.log(
    `spec:check OK — ${spec.size} endpoints agree across the OpenAPI spec, ` +
      `the on-disk route handlers, and the /llms.txt body (${specPaths.size} paths).`
  );
}

main();
