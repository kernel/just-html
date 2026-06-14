// Code-first OpenAPI infrastructure (Z1+). The single OpenAPIRegistry every
// resource registers its Zod schemas + paths into; scripts/gen-spec.ts runs the
// OpenApiGeneratorV31 over it to emit a parallel generated spec that we diff
// against the still-served hand-written lib/openapi/spec-yaml.ts. The route keeps
// serving the hand-written literal until the final cutover (Z5).
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
