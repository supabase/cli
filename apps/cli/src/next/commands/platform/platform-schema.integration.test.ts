import { describe, expect, it } from "vitest";

import { buildPlatformSchemaPayload } from "./platform-schema.ts";
import { platformOperationDescriptors } from "./platform-descriptors.ts";

function findPlatformOperationDescriptor(operationId: string) {
  const descriptor = platformOperationDescriptors.find(
    (candidate) => candidate.operationId === operationId,
  );
  if (descriptor === undefined) {
    throw new Error(`No platform operation descriptor was found for ${operationId}.`);
  }
  return descriptor;
}

describe("api schema payload", () => {
  it("falls back to the OpenAPI summary when a route has no separate description", () => {
    const payload = buildPlatformSchemaPayload(
      findPlatformOperationDescriptor("v1CreateLegacySigningKey"),
    );

    expect(payload).toMatchObject({
      route: "/v1/projects/{ref}/config/auth/signing-keys/legacy",
      method: "POST",
      summary:
        "Set up the project's existing JWT secret as an in_use JWT signing key. This endpoint will be removed in the future always check for HTTP 404 Not Found.",
      description:
        "Set up the project's existing JWT secret as an in_use JWT signing key. This endpoint will be removed in the future always check for HTTP 404 Not Found.",
    });
  });

  it("preserves distinct OpenAPI summary and description text", () => {
    const payload = buildPlatformSchemaPayload(
      findPlatformOperationDescriptor("v1ListAllProjects"),
    );

    expect(payload).toMatchObject({
      route: "/v1/projects",
      method: "GET",
      summary: "List all projects",
      description:
        "Returns a list of all projects you've previously created.\n\nUse `/v1/organizations/{slug}/projects` instead when possible to get more precise results and pagination support.",
    });
  });

  it("builds a canonical machine document for project creation", () => {
    const payload = buildPlatformSchemaPayload(findPlatformOperationDescriptor("v1CreateAProject"));

    expect(payload).not.toHaveProperty("http");
    expect(payload).not.toHaveProperty("request");
    expect(payload).not.toHaveProperty("inputHelp");
    expect(payload).toMatchObject({
      route: "/v1/projects",
      method: "POST",
      command: "supabase api request /v1/projects --method POST",
      input: {
        body: {
          kind: "json",
          required: true,
          contentType: "application/json",
          guidance: {
            summary: "Use `--json` for object-shaped JSON request bodies.",
          },
          channels: {
            json: {
              flag: "--json",
              required: {
                db_pass: {
                  type: "string",
                  sensitive: true,
                },
                name: {
                  type: "string",
                },
                organization_slug: {
                  type: "string",
                },
              },
              optional: {
                region_selection: {
                  oneOf: expect.any(Array),
                },
              },
            },
          },
        },
      },
      response: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: expect.any(Array),
          },
        },
      },
      examples: expect.arrayContaining([
        expect.objectContaining({
          command: expect.stringContaining("--json"),
        }),
      ]),
      projection: {
        flag: "--fields",
        available: expect.arrayContaining(["id", "ref", "status"]),
      },
    });
  });

  it("keeps binary body routes machine-friendly", () => {
    const payload = buildPlatformSchemaPayload(
      findPlatformOperationDescriptor("v1CreateAFunction"),
    );

    expect(payload).toMatchObject({
      route: "/v1/projects/{ref}/functions",
      input: {
        params: {
          flag: "--params",
          required: {
            ref: {
              type: "string",
            },
          },
        },
        body: {
          kind: "binary",
          guidance: {
            summary: "This request body expects raw bytes.",
            notes: expect.arrayContaining([
              "Use `--body-file <path>` to read bytes from a filesystem path.",
            ]),
          },
          channels: {
            body: {
              flag: "--body",
              schema: {
                type: "string",
                format: "binary",
              },
            },
          },
        },
      },
      examples: expect.arrayContaining([
        expect.objectContaining({
          command: expect.stringContaining("--body-file ./body.bin"),
        }),
      ]),
    });
  });

  it("splits multipart routes into structured and upload channels", () => {
    const payload = buildPlatformSchemaPayload(
      findPlatformOperationDescriptor("v1DeployAFunction"),
    );

    expect(payload).toMatchObject({
      route: "/v1/projects/{ref}/functions/deploy",
      input: {
        body: {
          kind: "multipart",
          contentType: "multipart/form-data",
          guidance: {
            summary:
              "This request body expects structured fields via `--json` and binary fields via `--upload`.",
            notes: expect.arrayContaining([
              "Use repeated `--upload field=path` flags for binary multipart fields, including array-valued fields.",
            ]),
          },
          channels: {
            json: {
              flag: "--json",
              required: {
                metadata: {
                  type: "object",
                },
              },
            },
            upload: {
              flag: "--upload",
              optional: {
                file: {
                  type: "array",
                  items: {
                    type: "string",
                    format: "binary",
                  },
                },
              },
            },
          },
        },
      },
      examples: expect.arrayContaining([
        expect.objectContaining({
          command: expect.stringContaining("--upload file=./file-1.bin"),
        }),
      ]),
    });
  });

  it("keeps urlencoded routes grouped under the json input channel", () => {
    const payload = buildPlatformSchemaPayload(
      findPlatformOperationDescriptor("v1ExchangeOauthToken"),
    );

    expect(payload).toMatchObject({
      route: "/v1/oauth/token",
      input: {
        body: {
          kind: "urlencoded",
          contentType: "application/x-www-form-urlencoded",
          guidance: {
            summary: "This request body expects structured fields passed to `--json`.",
          },
          channels: {
            json: {
              flag: "--json",
              optional: {
                grant_type: {
                  type: "string",
                  enum: expect.arrayContaining(["authorization_code", "refresh_token"]),
                },
              },
            },
          },
        },
      },
      examples: expect.arrayContaining([
        expect.objectContaining({
          command: expect.stringContaining("--json"),
        }),
      ]),
    });
  });

  it("collapses string-only union params into plain machine-readable strings", () => {
    const payload = buildPlatformSchemaPayload(findPlatformOperationDescriptor("v1DeleteABranch"));

    expect(payload).toMatchObject({
      route: "/v1/branches/{branch_id_or_ref}",
      input: {
        params: {
          flag: "--params",
          required: {
            branch_id_or_ref: {
              type: "string",
            },
          },
        },
      },
      examples: expect.arrayContaining([
        expect.objectContaining({
          command: expect.stringContaining('--params \'{"branch_id_or_ref":"branch-ref"}\''),
        }),
      ]),
    });
  });
});
