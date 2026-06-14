// lib/openapi/response-validator.ts — the runtime half of the Z0 contract test.
//
// Loads the served OpenAPI spec (the code-first lib/openapi/generated-spec.ts —
// the same bytes GET /api/spec.yaml serves), and exposes a validator that checks
// a live JSON response body against the response schema the spec documents for
// that (method, path template, status). Used by scripts/e2e.ts so that a response
// which violates its documented schema fails the e2e run.
//
// OpenAPI 3.1 schemas ARE JSON Schema 2020-12, so we validate with Ajv's 2020
// dialect (handles `type: [..., "null"]` and `$ref` into #/components/schemas).
// `strict: false` tolerates the OpenAPI-only annotations (example, etc.) that
// ride along inside schema objects.

import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import yaml from "js-yaml";
import { SPEC_YAML } from "@/lib/openapi/generated-spec";

type AnyObj = Record<string, unknown>;

const spec = yaml.load(SPEC_YAML) as {
  paths: Record<string, Record<string, AnyObj>>;
  components?: AnyObj;
};

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
// Register the whole document under "spec" so $ref: "#/components/..." resolves.
ajv.addSchema(spec, "spec");

// Cache compiled validators per (method path status).
const cache = new Map<string, ValidateFunction | null>();

/**
 * Resolve the response-body schema the spec documents for an operation, rewriting
 * local `#/...` $refs to the registered "spec#/..." base so Ajv resolves them.
 */
function rebaseRefs(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(rebaseRefs);
  if (node && typeof node === "object") {
    const out: AnyObj = {};
    for (const [k, v] of Object.entries(node as AnyObj)) {
      if (k === "$ref" && typeof v === "string" && v.startsWith("#/")) {
        out[k] = "spec" + v;
      } else {
        out[k] = rebaseRefs(v);
      }
    }
    return out;
  }
  return node;
}

function getResponseSchema(method: string, pathTemplate: string, status: number): unknown {
  const pathItem = spec.paths[pathTemplate];
  if (!pathItem) return undefined;
  const op = pathItem[method.toLowerCase()] as AnyObj | undefined;
  if (!op) return undefined;
  const responses = op.responses as AnyObj | undefined;
  if (!responses) return undefined;
  const resp = responses[String(status)] as AnyObj | undefined;
  if (!resp) return undefined;
  const content = resp.content as AnyObj | undefined;
  if (!content) return undefined;
  const appJson = content["application/json"] as AnyObj | undefined;
  if (!appJson || !appJson.schema) return undefined;
  return appJson.schema;
}

/**
 * Validate a parsed JSON body against the documented response schema for
 * (method, pathTemplate, status). Returns:
 *   { ok: true }                          — valid (or no schema is documented),
 *   { ok: false, errors }                 — body violates the documented schema.
 * pathTemplate is the OpenAPI path template, e.g. "/api/v1/docs/{slug}".
 */
export function validateResponseBody(
  method: string,
  pathTemplate: string,
  status: number,
  body: unknown
): { ok: true; documented: boolean } | { ok: false; documented: true; errors: string } {
  const key = `${method.toUpperCase()} ${pathTemplate} ${status}`;
  let validate = cache.get(key);
  if (validate === undefined) {
    const schema = getResponseSchema(method, pathTemplate, status);
    validate = schema ? ajv.compile(rebaseRefs(schema) as object) : null;
    cache.set(key, validate);
  }
  if (validate === null) return { ok: true, documented: false };
  const valid = validate(body);
  if (valid) return { ok: true, documented: true };
  const errors = ajv.errorsText(validate.errors, { separator: "; " });
  return { ok: false, documented: true, errors };
}
