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
