// Code-first OpenAPI infrastructure. The single OpenAPIRegistry every resource
// registers its Zod schemas + paths into; scripts/gen-spec.ts runs the
// OpenApiGeneratorV31 over it to emit the SERVED spec artifacts
// (lib/openapi/generated-spec.ts, served by GET /api/spec.yaml, and the parallel
// generated.yaml validated by @redocly/cli). The hand-written literal that used
// to be the source of truth was deleted at the Z5 cutover; this registry is now
// the single source for the whole documented surface.
//
// extendZodWithOpenApi(z) is called ONCE here so every `import { z }` downstream
// already has `.openapi()` available. Import z from THIS module (or just import
// this module for its side effect before using z) so the extension is applied.

import { z } from "zod";
import { OpenAPIRegistry, extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

// One shared registry for all resources. Resource modules (lib/docs/schemas.ts,
// future lib/<resource>/schemas.ts) call registry.register / registerPath into
// this instance at import time.
export const registry = new OpenAPIRegistry();

export { z };
