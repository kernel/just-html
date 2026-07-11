import spec from "@/lib/openapi/generated.json";

export const dynamic = "force-static";

const BODY = JSON.stringify(spec);

export function GET(): Response {
  return new Response(BODY, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
