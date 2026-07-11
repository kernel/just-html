import { ORIGIN } from "@/lib/auth/config";

export const dynamic = "force-static";

const DISCOVERY_URL = `${ORIGIN}/.well-known/integrations.json`;
const basis = { via: "declared", source: DISCOVERY_URL } as const;

const BODY = JSON.stringify({
  version: 3,
  summary:
    "Publish, share, edit, and discuss HTML documents through the justhtml.sh HTTP API.",
  credentials: {
    "justhtml-api-key": {
      type: "api_key",
      label: "justhtml.sh API key",
      generateUrl: `${ORIGIN}/auth.md`,
      setup:
        "Follow the [agent authentication flow](https://justhtml.sh/auth.md): register the human's email, have them read back the emailed 6-digit code, complete the claim, then poll the token endpoint for the long-lived `jh_live_…` key. Store it securely (the examples use `JUSTHTML_API_KEY`) and send it as a Bearer token.",
    },
  },
  surfaces: [
    {
      type: "http",
      slug: "justhtml-api",
      name: "justhtml.sh HTTP API",
      docs: `${ORIGIN}/llms.txt`,
      spec: `${ORIGIN}/openapi.json`,
      url: `${ORIGIN}/api/v1`,
      basis,
      auth: {
        status: "required",
        entries: [
          {
            use: [
              {
                id: "justhtml-api-key",
                mechanics: {
                  source: "http",
                  in: "header",
                  headerName: "Authorization",
                  scheme: "Bearer",
                },
              },
            ],
            basis,
          },
        ],
      },
    },
  ],
});

export function GET(): Response {
  return new Response(BODY, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
