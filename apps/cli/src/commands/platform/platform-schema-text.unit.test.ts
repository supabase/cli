import { describe, expect, it } from "vitest";

import { platformOperationDescriptors } from "./platform-descriptors.ts";
import { buildPlatformSchemaPayload, renderPlatformSchemaPayload } from "./platform-schema.ts";

function findPlatformOperationDescriptor(operationId: string) {
  const descriptor = platformOperationDescriptors.find(
    (candidate) => candidate.operationId === operationId,
  );
  if (descriptor === undefined) {
    throw new Error(`No platform operation descriptor was found for ${operationId}.`);
  }
  return descriptor;
}

function createSchemaPayload(
  overrides: Partial<Parameters<typeof renderPlatformSchemaPayload>[0]> = {},
): Parameters<typeof renderPlatformSchemaPayload>[0] {
  return {
    route: "/v1/test",
    method: "GET",
    command: "supabase api request /v1/test",
    summary: "",
    description: "",
    input: {},
    examples: [],
    projection: {
      flag: "--fields",
      available: [],
    },
    ...overrides,
  };
}

describe("platform schema text rendering", () => {
  it("renders a summary-only multi-sentence route without duplicating the first sentence", () => {
    const payload = buildPlatformSchemaPayload(
      findPlatformOperationDescriptor("v1CreateLegacySigningKey"),
    );
    const rendered = renderPlatformSchemaPayload(payload);

    expect(rendered).toContain(
      "Set up the project's existing JWT secret as an in_use JWT signing key. This endpoint will be removed in the future always check for HTTP 404 Not Found.",
    );
    expect(rendered).not.toContain(
      [
        "  Set up the project's existing JWT secret as an in_use JWT signing key.",
        "  Set up the project's existing JWT secret as an in_use JWT signing key. This endpoint will be removed in the future always check for HTTP 404 Not Found.",
      ].join("\n"),
    );
  });

  it("renders distinct summary and description lines when both are provided", () => {
    const payload = buildPlatformSchemaPayload(
      findPlatformOperationDescriptor("v1ListAllProjects"),
    );
    const rendered = renderPlatformSchemaPayload(payload);

    expect(rendered).toContain("  List all projects");
    expect(rendered).toContain("  Returns a list of all projects you've previously created.");
  });

  it("renders description-only payloads as a single description line", () => {
    const rendered = renderPlatformSchemaPayload(
      createSchemaPayload({
        description: "Inspect the current state of the resource.",
      }),
    );

    expect(rendered).toContain("  Inspect the current state of the resource.");
    expect(rendered).not.toContain("  \n  Inspect the current state of the resource.");
  });

  it("renders only the description when it starts with the summary verbatim", () => {
    const rendered = renderPlatformSchemaPayload(
      createSchemaPayload({
        summary: "Bulk update functions",
        description:
          "Bulk update functions. It will create a new function or replace existing. The operation is idempotent. NOTE: You will need to manually bump the version.",
      }),
    );

    expect(rendered).toContain(
      "  Bulk update functions. It will create a new function or replace existing. The operation is idempotent. NOTE: You will need to manually bump the version.",
    );
    expect(rendered).not.toContain(
      [
        "  Bulk update functions",
        "  Bulk update functions. It will create a new function or replace existing. The operation is idempotent. NOTE: You will need to manually bump the version.",
      ].join("\n"),
    );
  });

  it("renders compact human-first schema output for json body routes", () => {
    const payload = buildPlatformSchemaPayload(
      findPlatformOperationDescriptor("v1CreateLoginRole"),
    );
    const rendered = renderPlatformSchemaPayload(payload);

    expect(rendered).toContain("Route");
    expect(rendered).toContain("Input");
    expect(rendered).toContain("Returns");
    expect(rendered).toContain("Example");
    expect(rendered).toContain("Available --fields");
    expect(rendered).toContain("POST /v1/projects/{ref}/cli/login-role");
    expect(rendered).toContain("[Beta] Create a login role for CLI with temporary password");
    expect(rendered).toContain("  --params");
    expect(rendered).toContain("ref: string - Project ref");
    expect(rendered).toContain(
      "      hint: Use `--params` with inline JSON or `-` to read JSON from stdin.",
    );
    expect(rendered).toContain("  --json");
    expect(rendered).toContain("read_only: boolean");
    expect(rendered).toContain("password: string (sensitive)");
    expect(rendered).toContain("ttl_seconds: integer");
    expect(rendered).toContain(
      "  supabase api request /v1/projects/{ref}/cli/login-role --method POST",
    );
    expect(rendered).not.toContain("Pass the required JSON fields with `--json`.");
    expect(rendered).not.toContain("Required Input");
    expect(rendered).not.toContain("Optional Input");
    expect(rendered).not.toContain("ttl_seconds: integer (int64)");
    expect(rendered).not.toContain("http:");
    expect(rendered).not.toContain("inputHelp:");
    expect(rendered).not.toContain("required: true");
    expect(rendered).not.toContain("nullable: false");
    expect(rendered).not.toContain("sensitive: false");
  });

  it("renders return fields with TypeScript-style optional and null notation", () => {
    const rendered = renderPlatformSchemaPayload(
      createSchemaPayload({
        response: {
          type: "object",
          required: ["name", "token"],
          properties: {
            name: {
              type: "string",
            },
            id: {
              type: "string",
            },
            api_key: {
              type: "string",
              nullable: true,
            },
            type: {
              type: "string",
              enum: ["legacy", "publishable", "secret"],
              nullable: true,
            },
            token: {
              type: "string",
              sensitive: true,
            },
            old_field: {
              type: "integer",
              nullable: true,
              deprecated: true,
            },
            tags: {
              type: "array",
              items: {
                type: "string",
              },
            },
            secret_jwt_template: {
              type: "object",
              nullable: true,
              properties: {
                sub: {
                  type: "string",
                },
              },
              required: ["sub"],
            },
            variant: {
              oneOf: [{ type: "string" }, { type: "integer" }],
              nullable: true,
            },
          },
        },
      }),
    );

    expect(rendered).toContain("Returns");
    expect(rendered).toContain("  name: string");
    expect(rendered).toContain("  id?: string");
    expect(rendered).toContain("  api_key?: string | null");
    expect(rendered).toContain("  type?: 'legacy' | 'publishable' | 'secret' | null");
    expect(rendered).toContain("  token: string (sensitive)");
    expect(rendered).toContain("  old_field?: integer | null (deprecated)");
    expect(rendered).toContain("  tags?: string[]");
    expect(rendered).toContain("  secret_jwt_template?: object | null");
    expect(rendered).toContain("    sub: string");
    expect(rendered).toContain("  variant?: string | integer | null");
    expect(rendered).not.toContain("(optional, nullable)");
    expect(rendered).not.toContain("id: string (optional)");
  });

  it("renders multipart guidance without dumping nested renderer state", () => {
    const payload = buildPlatformSchemaPayload(
      findPlatformOperationDescriptor("v1DeployAFunction"),
    );
    const rendered = renderPlatformSchemaPayload(payload);

    expect(rendered).toContain("Input");
    expect(rendered).toContain("  --json");
    expect(rendered).toContain("  --upload");
    expect(rendered).toContain("metadata: object");
    expect(rendered).toContain("file?: binary[]");
    expect(rendered).toContain(
      "note: Use repeated `--upload field=path` flags for binary multipart fields, including array-valued fields.",
    );
    expect(rendered.indexOf("  --json")).toBeLessThan(rendered.indexOf("  --upload"));
    expect(rendered).not.toContain("properties:");
    expect(rendered).not.toContain("location:");
  });

  it("renders raw body routes with body guidance attached to the body channel", () => {
    const payload = buildPlatformSchemaPayload(
      findPlatformOperationDescriptor("v1CreateAFunction"),
    );
    const rendered = renderPlatformSchemaPayload(payload);

    expect(rendered).toContain("Input");
    expect(rendered).toContain("  --body");
    expect(rendered).toContain("    body: binary");
    expect(rendered).toContain("      hint: This request body expects raw bytes.");
    expect(rendered).toContain(
      "      note: Use `--body-file <path>` to read bytes from a filesystem path.",
    );
  });

  it("renders params channels with required and optional groups together", () => {
    const rendered = renderPlatformSchemaPayload(
      createSchemaPayload({
        input: {
          params: {
            flag: "--params",
            guidance: "Pass route values with --params JSON.",
            required: {
              ref: {
                type: "string",
                description: "Project ref",
              },
              id: {
                type: "string",
              },
            },
            optional: {
              reveal: {
                type: "boolean",
                description: "Boolean string, true or false",
              },
            },
          },
        },
        examples: [
          {
            description: "Pass the required path values.",
            command:
              'supabase api request /v1/test --params \'{"ref":"project-ref","id":"resource-id"}\'',
          },
        ],
      }),
    );

    expect(rendered).toContain(
      [
        "Input",
        "  --params",
        "    ref: string - Project ref",
        "    id: string",
        "    reveal?: boolean - Boolean string, true or false",
        "      hint: Pass route values with --params JSON.",
      ].join("\n"),
    );
    expect(rendered).toContain("Example");
    expect(rendered).not.toContain("Examples\n  Pass the required path values.");
    expect(rendered).not.toContain("    Required");
    expect(rendered).not.toContain("    Optional");
  });

  it("omits empty optional groups when a channel only has required fields", () => {
    const rendered = renderPlatformSchemaPayload(
      createSchemaPayload({
        input: {
          body: {
            kind: "json",
            required: true,
            channels: {
              json: {
                flag: "--json",
                required: {
                  name: {
                    type: "string",
                  },
                },
              },
            },
          },
        },
      }),
    );

    expect(rendered).toContain(["Input", "  --json", "    name: string"].join("\n"));
    expect(rendered).not.toContain("    Optional");
    expect(rendered).not.toContain("    Required");
  });

  it("renders channel hints after the field list", () => {
    const rendered = renderPlatformSchemaPayload(
      createSchemaPayload({
        input: {
          params: {
            flag: "--params",
            guidance: "Use `--params` with inline JSON or `-` to read JSON from stdin.",
            required: {
              ref: {
                type: "string",
              },
            },
            optional: {
              reveal: {
                type: "boolean",
              },
            },
          },
        },
      }),
    );

    expect(rendered.indexOf("    ref: string")).toBeLessThan(
      rendered.indexOf(
        "      hint: Use `--params` with inline JSON or `-` to read JSON from stdin.",
      ),
    );
    expect(rendered.indexOf("    reveal?: boolean")).toBeLessThan(
      rendered.indexOf(
        "      hint: Use `--params` with inline JSON or `-` to read JSON from stdin.",
      ),
    );
  });

  it("renders no-input payloads as Input None", () => {
    const rendered = renderPlatformSchemaPayload(createSchemaPayload());

    expect(rendered).toContain(["Input", "  None."].join("\n"));
  });
});
