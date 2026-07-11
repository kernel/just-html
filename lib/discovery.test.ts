import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { GET as getSkillIndex } from "@/app/.well-known/agent-skills/index.json/route";
import { GET as getSkill } from "@/app/.well-known/agent-skills/just-html/SKILL.md/route";
import { GET as getIntegrations } from "@/app/.well-known/integrations.json/route";
import { GET as getOpenApi } from "@/app/openapi.json/route";

const basis = z
  .object({
    via: z.literal("declared"),
    source: z.literal("https://justhtml.sh/.well-known/integrations.json"),
  })
  .strict();

const integrationsV3 = z
  .object({
    version: z.literal(3),
    summary: z.string().optional(),
    credentials: z
      .record(
        z.string(),
        z
          .object({
            type: z.string(),
            label: z.string(),
            generateUrl: z.string().url().optional(),
            setup: z.string(),
          })
          .strict()
      )
      .optional(),
    surfaces: z
      .array(
        z
          .object({
            type: z.literal("http"),
            slug: z.string(),
            name: z.string(),
            docs: z.string().url().optional(),
            spec: z.string().url().optional(),
            url: z.string().url().optional(),
            basis,
            auth: z
              .object({
                status: z.literal("required"),
                entries: z.array(
                  z
                    .object({
                      use: z.array(
                        z
                          .object({
                            id: z.string(),
                            mechanics: z
                              .object({
                                source: z.literal("http"),
                                in: z.literal("header"),
                                headerName: z.string(),
                                scheme: z.string(),
                              })
                              .strict(),
                          })
                          .strict()
                      ),
                      basis,
                    })
                    .strict()
                ),
              })
              .strict(),
          })
          .strict()
      )
      .optional(),
  })
  .strict();

describe("integration discovery", () => {
  it("serves a valid integrations.sh v3 declaration", async () => {
    const response = getIntegrations();
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");

    const document = integrationsV3.parse(await response.json());
    expect(document.surfaces).toHaveLength(1);
    expect(document.surfaces?.[0]).toMatchObject({
      type: "http",
      url: "https://justhtml.sh/api/v1",
      spec: "https://justhtml.sh/openapi.json",
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
          },
        ],
      },
    });
  });

  it("serves the generated OpenAPI document as JSON", async () => {
    const response = getOpenApi();
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");

    const document = (await response.json()) as {
      openapi: string;
      servers: Array<{ url: string }>;
      components: { securitySchemes: Record<string, unknown> };
    };
    expect(document.openapi).toBe("3.1.0");
    expect(document.servers).toContainEqual(
      expect.objectContaining({ url: "https://justhtml.sh" })
    );
    expect(document.components.securitySchemes).toHaveProperty("bearerApiKey");
  });

  it("publishes an Agent Skills index with a matching artifact digest", async () => {
    const indexResponse = getSkillIndex();
    const skillResponse = getSkill();
    expect(indexResponse.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(skillResponse.headers.get("content-type")).toBe("text/markdown; charset=utf-8");

    const index = (await indexResponse.json()) as {
      $schema: string;
      skills: Array<{ name: string; type: string; url: string; digest: string }>;
    };
    const skill = await skillResponse.text();
    const digest = createHash("sha256").update(skill).digest("hex");

    expect(index.$schema).toBe("https://schemas.agentskills.io/discovery/0.2.0/schema.json");
    expect(index.skills).toEqual([
      expect.objectContaining({
        name: "just-html",
        type: "skill-md",
        url: "https://justhtml.sh/.well-known/agent-skills/just-html/SKILL.md",
        digest: `sha256:${digest}`,
      }),
    ]);
  });
});
