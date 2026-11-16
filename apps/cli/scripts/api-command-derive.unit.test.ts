import { describe, expect, it } from "@effect/vitest";
import type { ApiCommandName } from "../src/commands/api/api-command-names.ts";
import { deriveApiCommands } from "./api-command-derive.ts";

const DIALECT = "https://json-schema.org/draft/2020-12/schema";

const jsonResponse = (schema: unknown) => ({
  "200": { description: "ok", content: { "application/json": { schema } } },
});

const operation = (overrides: Record<string, unknown>) => ({
  summary: "Do the thing",
  "x-scalar-stability": "experimental",
  parameters: [{ name: "ref", in: "path", required: true, schema: { type: "string" } }],
  responses: jsonResponse({ type: "object", properties: { ok: { type: "boolean" } } }),
  ...overrides,
});

const envelope = (attributes: Record<string, unknown>) => ({
  content: {
    "application/json": {
      schema: {
        type: "object",
        properties: {
          data: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["thing"] },
              attributes: {
                type: "object",
                required: ["name"],
                properties: { name: { type: "string" }, ...attributes },
              },
            },
          },
        },
      },
    },
  },
});

const derive = (operations: Record<string, unknown>, names: Record<string, ApiCommandName>) =>
  deriveApiCommands({
    spec: {
      paths: Object.fromEntries(
        Object.entries(operations).map(([id, node]) => [
          `/v1/projects/{ref}/${id}`,
          { post: { operationId: id, ...(node as object) } },
        ]),
      ),
      components: { schemas: { Tags: { type: "array", items: { type: "string" } } } },
    },
    names,
    nouns: { thing: { description: "Manage things", feature: "things" } },
    operationIdMap: Object.fromEntries(
      Object.keys(operations).map((id) => [id, "v2EnableWarehouse" as const]),
    ),
    handWrittenTopLevel: new Set(["db"]),
  });

const create: ApiCommandName = { group: "thing", method: "create" };

describe("deriveApiCommands", () => {
  it("binds envelope body fields by JSON pointer and the project ref to the target", () => {
    const result = derive(
      {
        "create-thing": operation({
          requestBody: envelope({ tags: { type: "array", items: { type: "string" } } }),
        }),
      },
      { "create-thing": { ...create, flags: { tags: "tag" } } },
    );

    expect(result.problems).toEqual([]);
    const [entry] = result.entries;
    expect(entry?.body).toEqual({
      contentType: "application/json",
      kind: "json-envelope",
      type: "thing",
    });
    expect(entry?.response).toEqual({ status: 200, kind: "json" });
    expect(entry?.flags.map((flag) => [flag.name, flag.required, flag.repeatable])).toEqual([
      ["name", true, false],
      ["tag", false, true],
    ]);
    expect(entry?.bindings).toEqual([
      { location: "path", name: "ref", source: "target" },
      {
        location: "body",
        name: "name",
        pointer: "/data/attributes/name",
        source: "flag",
        flag: "name",
      },
      {
        location: "body",
        name: "tags",
        pointer: "/data/attributes/tags",
        source: "flag",
        flag: "tag",
      },
    ]);
  });

  it("binds plain body fields at the body root and inlines referenced schemas", () => {
    const result = derive(
      {
        "create-thing": operation({
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { display_name: { type: "string" } },
                },
              },
            },
          },
          responses: jsonResponse({ $ref: "#/components/schemas/Tags" }),
        }),
      },
      { "create-thing": create },
    );

    expect(result.problems).toEqual([]);
    expect(result.entries[0]?.body?.kind).toBe("json-object");
    expect(result.entries[0]?.bindings).toContainEqual({
      location: "body",
      name: "display_name",
      pointer: "/display_name",
      source: "flag",
      flag: "display-name",
    });
    expect(result.schemas["create-thing"]?.result).toEqual({
      $schema: DIALECT,
      type: "array",
      items: { type: "string" },
    });
  });

  it("turns a string enum query parameter into flag choices and an empty response into null", () => {
    const result = derive(
      {
        "list-things": operation({
          parameters: [
            { name: "ref", in: "path", required: true, schema: { type: "string" } },
            { name: "sort", in: "query", schema: { type: "string", enum: ["asc", "desc"] } },
          ],
          responses: { "204": { description: "none" } },
        }),
      },
      { "list-things": { group: "thing", method: "list" } },
    );

    expect(result.problems).toEqual([]);
    expect(result.entries[0]?.flags[0]).toMatchObject({ name: "sort", choices: ["asc", "desc"] });
    expect(result.entries[0]?.response).toEqual({ status: 204, kind: "empty" });
    expect(result.schemas["list-things"]?.result).toEqual({ $schema: DIALECT, type: "null" });
  });

  it.each([
    [
      "a nested object body field",
      operation({ requestBody: envelope({ nested: { type: "object", properties: {} } }) }),
      'body field "nested"',
    ],
    [
      "a binary success response",
      operation({
        responses: { "200": { description: "file", content: { "application/octet-stream": {} } } },
      }),
      "binary or streaming",
    ],
  ])("rejects %s", (_label, node, message) => {
    const result = derive({ "create-thing": node }, { "create-thing": create });

    expect(result.entries).toEqual([]);
    expect(result.problems.join("\n")).toContain(message);
  });

  it("rejects a body field that collides with a reserved runtime flag", () => {
    const result = derive(
      { "create-thing": operation({ requestBody: envelope({ wait: { type: "boolean" } }) }) },
      { "create-thing": create },
    );

    expect(result.problems.join("\n")).toContain('"--wait"');
  });

  it("rejects a wait pointer that does not resolve in the response", () => {
    const result = derive(
      {
        "create-thing": operation({}),
        "get-thing": operation({}),
      },
      {
        "create-thing": {
          ...create,
          wait: {
            read: "get-thing",
            params: {},
            status: "/data/attributes/missing",
            succeeded: ["done"],
            failed: [],
          },
        },
        "get-thing": { group: "thing", method: "get" },
      },
    );

    expect(result.problems.join("\n")).toContain('wait.status pointer "/data/attributes/missing"');
  });

  it("converts OpenAPI 3.0 schema keywords to JSON Schema 2020-12", () => {
    const result = derive(
      {
        "get-thing": operation({
          responses: jsonResponse({
            type: "object",
            properties: {
              name: { type: "string", nullable: true, example: "a" },
              count: {
                type: "integer",
                minimum: 0,
                exclusiveMinimum: true,
                maximum: 9,
                exclusiveMaximum: false,
              },
              any: { nullable: true, description: "free" },
            },
            discriminator: { propertyName: "name" },
          }),
        }),
      },
      { "get-thing": { group: "thing", method: "get" } },
    );

    expect(result.problems).toEqual([]);
    expect(result.schemas["get-thing"]?.result).toEqual({
      $schema: DIALECT,
      type: "object",
      properties: {
        name: { type: ["string", "null"], examples: ["a"] },
        count: { type: "integer", exclusiveMinimum: 0, maximum: 9 },
        any: { anyOf: [{ description: "free" }, { type: "null" }] },
      },
    });
  });

  it("rejects a schema keyword it cannot convert", () => {
    const result = derive(
      {
        "get-thing": operation({
          responses: jsonResponse({ type: "string", contentMediaType: "x" }),
        }),
      },
      { "get-thing": { group: "thing", method: "get" } },
    );

    expect(result.problems.join("\n")).toContain('keyword "contentMediaType"');
  });
});
