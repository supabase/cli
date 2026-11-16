import { describe, expect, it } from "@effect/vitest";
import type { ApiCommandOverride } from "../src/commands/api/api-command-overrides.ts";
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

const derive = (
  operations: Record<string, unknown>,
  overrides: Record<string, ApiCommandOverride>,
) =>
  deriveApiCommands({
    spec: {
      paths: Object.fromEntries(
        Object.entries(operations).map(([id, node]) => [
          `/v1/projects/{ref}/${id}`,
          { [id.startsWith("get-") ? "get" : "post"]: { operationId: id, ...(node as object) } },
        ]),
      ),
      components: { schemas: { Tags: { type: "array", items: { type: "string" } } } },
    },
    overrides,
    nouns: { thing: { description: "Manage things", feature: "things" } },
    operationIdMap: Object.fromEntries(
      Object.keys(operations).map((id) => [id, "v2EnableWarehouse" as const]),
    ),
    handWrittenTopLevel: new Set(["db"]),
  });

const create: ApiCommandOverride = { group: "thing", method: "create" };

describe("deriveApiCommands", () => {
  it("binds envelope body fields by JSON pointer and the project ref to the target", () => {
    const result = derive(
      {
        "create-thing": operation({
          requestBody: envelope({ tags: { type: "array", items: { type: "string" } } }),
        }),
      },
      { "create-thing": create },
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

  it("names a command from the operation's x-operation alone", () => {
    const result = derive(
      { "create-thing": operation({ "x-operation": { group: "thing", method: "create" } }) },
      {},
    );

    expect(result.problems).toEqual([]);
    expect(result.entries.map((entry) => entry.command)).toEqual([["thing", "create"]]);
  });

  it("lets an override entry replace the name and rename a single flag", () => {
    const result = derive(
      {
        "create-thing": operation({
          "x-operation": { group: "thing", method: "create" },
          requestBody: envelope({ tags: { type: "array", items: { type: "string" } } }),
        }),
      },
      { "create-thing": { method: "update", flags: { name: "title", tags: "tg" } } },
    );

    expect(result.problems).toEqual([]);
    const [entry] = result.entries;
    expect(entry?.command).toEqual(["thing", "update"]);
    expect(entry?.flags.map((flag) => flag.name)).toEqual(["title", "tg"]);
  });

  it("names array body flags in the singular and keeps other fields as they are", () => {
    const list = { type: "array", items: { type: "string" } };
    const result = derive(
      {
        "create-thing": operation({
          requestBody: envelope({
            categories: list,
            tables: list,
            access: list,
            status: list,
            analysis: list,
            sizes: { type: "string" },
          }),
        }),
      },
      { "create-thing": create },
    );

    expect(result.problems).toEqual([]);
    expect(result.entries[0]?.flags.map((flag) => flag.name)).toEqual([
      "name",
      "category",
      "table",
      "access",
      "status",
      "analysis",
      "sizes",
    ]);
  });

  it("rejects a singularised flag that collides with another flag", () => {
    const result = derive(
      {
        "create-thing": operation({
          requestBody: envelope({
            table: { type: "string" },
            tables: { type: "array", items: { type: "string" } },
          }),
        }),
      },
      { "create-thing": create },
    );

    expect(result.problems.join("\n")).toContain('"--table"');
  });

  it("marks writeOnly and password-format body fields sensitive", () => {
    const result = derive(
      {
        "create-thing": operation({
          requestBody: envelope({
            api_secret: { type: "string", writeOnly: true },
            pin: { type: "string", format: "password" },
          }),
        }),
      },
      { "create-thing": create },
    );

    expect(result.problems).toEqual([]);
    expect(result.entries[0]?.flags.map((flag) => [flag.name, flag.sensitive === true])).toEqual([
      ["name", false],
      ["api-secret", true],
      ["pin", true],
    ]);
  });

  it("accepts a credential-like field that is marked x-sensitive or listed by the table and rejects it otherwise", () => {
    const body = (api_key: Record<string, unknown>) => envelope({ api_key });
    const flagOf = (result: ReturnType<typeof derive>) =>
      result.entries[0]?.flags.find((flag) => flag.name === "api-key");

    const marked = derive(
      { "create-thing": operation({ requestBody: body({ type: "string", "x-sensitive": true }) }) },
      { "create-thing": create },
    );
    const listed = derive(
      { "create-thing": operation({ requestBody: body({ type: "string" }) }) },
      { "create-thing": { ...create, sensitive: ["api_key"] } },
    );
    const unreviewed = derive(
      { "create-thing": operation({ requestBody: body({ type: "string" }) }) },
      { "create-thing": create },
    );

    expect(marked.problems).toEqual([]);
    expect(flagOf(marked)?.sensitive).toBe(true);
    expect(listed.problems).toEqual([]);
    expect(flagOf(listed)?.sensitive).toBe(true);
    expect(unreviewed.problems.join("\n")).toContain('"api_key" looks like a credential');
  });

  describe("wait from response links", () => {
    const changeResponse = (links: unknown) => ({
      "202": {
        description: "accepted",
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: { data: { type: "object", properties: { id: { type: "string" } } } },
            },
          },
        },
        links,
      },
    });
    const poll = {
      status: "/data/attributes/status",
      succeeded: ["done"],
      failed: ["broken"],
      error: "/data/attributes/reason",
    };
    const readThing = operation({
      "x-operation": { group: "thing", method: "get", poll },
      parameters: [
        { name: "ref", in: "path", required: true, schema: { type: "string" } },
        { name: "thing_id", in: "query", schema: { type: "string" } },
      ],
      responses: jsonResponse({
        type: "object",
        properties: {
          data: {
            type: "object",
            properties: {
              attributes: {
                type: "object",
                properties: {
                  status: { type: "string", enum: ["done", "broken", "pending"] },
                  reason: { type: "string" },
                },
              },
            },
          },
        },
      }),
    });
    const link = (parameters: Record<string, string>, operationId = "get-thing") => ({
      setup: { operationId, parameters },
    });
    const changeThing = (links: unknown) =>
      operation({
        "x-operation": { group: "thing", method: "create" },
        responses: changeResponse(links),
      });

    it("builds the wait from the polled target and leaves the shared path parameter to the runtime", () => {
      const result = derive(
        {
          "create-thing": changeThing(
            link({ ref: "$request.path.ref", thing_id: "$response.body#/data/id" }),
          ),
          "get-thing": readThing,
        },
        {},
      );

      expect(result.problems).toEqual([]);
      expect(result.entries.find((entry) => entry.operationId === "create-thing")?.wait).toEqual({
        read: "get-thing",
        params: { thing_id: "/data/id" },
        ...poll,
      });
      expect(
        result.entries.find((entry) => entry.operationId === "get-thing")?.wait,
      ).toBeUndefined();
    });

    it("prefers an explicit wait over a link", () => {
      const explicit = {
        read: "get-thing",
        params: {},
        status: "/data/attributes/reason",
        succeeded: ["x"],
        failed: [],
      };
      const result = derive(
        {
          "create-thing": changeThing(link({ thing_id: "$response.body#/data/id" })),
          "get-thing": readThing,
        },
        { "create-thing": { wait: explicit } },
      );

      expect(result.problems).toEqual([]);
      expect(result.entries.find((entry) => entry.operationId === "create-thing")?.wait).toEqual(
        explicit,
      );
    });

    it("ignores a link whose target has no poll", () => {
      const result = derive(
        {
          "create-thing": changeThing(link({})),
          "get-thing": operation({ "x-operation": { group: "thing", method: "get" } }),
        },
        {},
      );

      expect(result.problems).toEqual([]);
      expect(result.entries.find((entry) => entry.operationId === "create-thing")?.wait).toBe(
        undefined,
      );
    });

    it.each([
      [
        "an unsupported expression",
        link({ thing_id: "$request.query.id" }),
        "unsupported expression",
      ],
      ["an unknown target", link({}, "get-missing"), 'unknown operation "get-missing"'],
      [
        "a path parameter the command lacks",
        link({ ref: "$request.path.other" }),
        "needs a path parameter of that name",
      ],
    ])("rejects %s", (_label, links, message) => {
      const result = derive({ "create-thing": changeThing(links), "get-thing": readThing }, {});

      expect(result.problems.join("\n")).toContain(message);
    });
  });

  it.each([
    [
      "a verb outside the vocabulary",
      { "create-thing": operation({}) },
      { "create-thing": { group: "thing", method: "frobnicate" } },
      'verb "frobnicate" is outside the vocabulary',
    ],
    [
      "an unknown key in x-operation",
      {
        "create-thing": operation({
          "x-operation": { group: "thing", method: "create", bogus: 1 },
        }),
      },
      {},
      "create-thing: invalid x-operation",
    ],
    [
      "a CLI-only key in x-operation",
      {
        "create-thing": operation({
          "x-operation": { group: "thing", method: "create", flags: { name: "label" } },
        }),
      },
      {},
      "create-thing: invalid x-operation",
    ],
    [
      "an override entry that leaves the operation unnamed",
      { "create-thing": operation({}) },
      { "create-thing": { flags: { name: "label" } } },
      "gives no command name",
    ],
    [
      "an override entry for an operation missing from the spec",
      { "create-thing": operation({ "x-operation": { group: "thing", method: "create" } }) },
      { "missing-thing": create },
      "missing-thing: override entry has no operation in the spec",
    ],
  ])("rejects %s", (_label, operations, overrides, message) => {
    const result = derive(operations, overrides);

    expect(result.problems.join("\n")).toContain(message);
  });
});
