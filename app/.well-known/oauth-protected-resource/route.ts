import { RESOURCE, ISSUER, SCOPES } from "@/lib/auth/config";

// RFC 9728 protected-resource metadata (§2.1). Plain route handler, cached.
export const dynamic = "force-static";

const BODY = JSON.stringify({
  resource: RESOURCE,
  resource_name: "justhtml.sh",
  authorization_servers: [ISSUER],
  scopes_supported: SCOPES,
  bearer_methods_supported: ["header"],
});

export function GET(): Response {
  return new Response(BODY, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}
