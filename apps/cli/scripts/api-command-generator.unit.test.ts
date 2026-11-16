import { describe, expect, it } from "vitest";
import openapi from "@supabase/api/openapi.json";
import { generateApiCommands } from "./api-command-generator.ts";
import { apiCommandOperationIds } from "./api-command-operations.ts";
import { generatedCommands } from "../src/command-internal/api/generated.ts";
import snapshot from "../src/command-internal/api/api-commands.snapshot.json";

const fixture = () => ({
  components: { schemas: {} },
  paths: {
    "/v2/projects/{ref}/jobs/start": {
      post: {
        operationId: "start-job",
        summary: "Start a job",
        "x-cli": {
          group: "jobs",
          method: "start",
          flags: { "target.names": "name" },
          wait: {
            read: "get-job",
            params: { job_id: "/data/id" },
            status: "/data/attributes/status",
            succeeded: ["succeeded"],
            failed: ["failed"],
          },
        },
        parameters: [{ name: "ref", in: "path", required: true }],
        responses: {
          "202": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: { type: "object", properties: { id: { type: "string" } } },
                  },
                },
              },
            },
          },
        },
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["target"],
                properties: {
                  target: {
                    type: "object",
                    required: ["names"],
                    properties: { names: { type: "array", items: { type: "string" } } },
                  },
                  count: { type: "integer" },
                  enabled: { type: "boolean" },
                },
              },
            },
          },
        },
      },
    },
    "/v2/projects/{ref}/jobs/current": {
      get: {
        operationId: "get-job",
        parameters: [
          { name: "ref", in: "path", required: true },
          { name: "job_id", in: "query", required: true },
        ],
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: {
                      type: "object",
                      properties: {
                        attributes: {
                          type: "object",
                          properties: {
                            status: { type: "string", enum: ["running", "succeeded", "failed"] },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
});

describe("API command generation", () => {
  it("derives flags from nested inputs and authored renames", () => {
    expect(generateApiCommands(fixture(), ["start-job"])[0]).toMatchObject({
      group: "jobs",
      method: "start",
      experimental: false,
      constants: [],
      fields: [
        {
          name: "name",
          path: ["target", "names"],
          type: "string",
          required: true,
          repeatable: true,
        },
        { name: "count", path: ["count"], type: "integer", required: false },
        { name: "enabled", path: ["enabled"], type: "boolean", required: false },
      ],
    });
  });
  it("rejects reserved flag collisions instead of changing global flag semantics", () => {
    const document = fixture();
    document.paths["/v2/projects/{ref}/jobs/start"].post["x-cli"].flags["target.names"] = "yes";
    expect(() => generateApiCommands(document, ["start-job"])).toThrow("Flag collision");
  });
  it("rejects an unresolved rename", () => {
    const document = fixture();
    Object.assign(document.paths["/v2/projects/{ref}/jobs/start"].post["x-cli"].flags, {
      missing: "unknown",
    });
    expect(() => generateApiCommands(document, ["start-job"])).toThrow("Unresolved flag rename");
  });
  it("keeps generated data and review snapshot synchronized with the API contract", () => {
    const rendered = generateApiCommands(openapi, apiCommandOperationIds);
    expect(generatedCommands).toEqual(rendered);
    expect(snapshot).toEqual(rendered);
  });
  it("rejects a waiter with missing response pointers", () => {
    const document = fixture();
    document.paths["/v2/projects/{ref}/jobs/start"].post["x-cli"].wait.params.job_id = "/missing";
    expect(() => generateApiCommands(document, ["start-job"])).toThrow();
  });
});
