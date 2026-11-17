import { describe, expect, it } from "@effect/vitest";
import type { ApiNoun } from "../src/commands/api/api-command-policy.ts";
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

const thingNoun: ApiNoun = {
  description: "Manage things",
  feature: "things",
  groups: { sub: "Manage sub things", "sub.deep": "Manage deep things", status: "Status" },
};

/** The spec path of an operation: the project ref, then one segment per other path parameter. */
const pathOf = (id: string, node: unknown): string => {
  const parameters: unknown = Reflect.get(Object(node), "parameters");
  const extra = Array.isArray(parameters)
    ? parameters
        .filter((parameter) => parameter.in === "path" && parameter.name !== "ref")
        .map((parameter) => `/{${parameter.name}}`)
    : [];
  return `/v1/projects/{ref}/${id}${extra.join("")}`;
};

const derive = (
  operations: Record<string, unknown>,
  generated: ReadonlyArray<string> = Object.keys(operations),
  options: {
    readonly schemas?: Record<string, unknown>;
    readonly overrides?: Partial<Parameters<typeof deriveApiCommands>[0]>;
  } = {},
) =>
  deriveApiCommands({
    spec: {
      paths: Object.fromEntries(
        Object.entries(operations).map(([id, node]) => [
          pathOf(id, node),
          { [id.startsWith("get-") ? "get" : "post"]: { operationId: id, ...(node as object) } },
        ]),
      ),
      components: {
        schemas: { Tags: { type: "array", items: { type: "string" } }, ...options.schemas },
      },
    },
    generated,
    pollTargets: {},
    nouns: { thing: thingNoun },
    operationIdMap: Object.fromEntries(
      Object.keys(operations).map((id) => [id, "v2EnableWarehouse" as const]),
    ),
    handWrittenTopLevel: new Set(["db"]),
    ...options.overrides,
  });

const named = (method: string) => ({ "x-operation": { group: "thing", method } });
const create = named("create");

describe("deriveApiCommands", () => {
  it("binds envelope body fields by JSON pointer and the project ref to the target", () => {
    const result = derive({
      "create-thing": operation({
        ...create,
        requestBody: envelope({ tags: { type: "array", items: { type: "string" } } }),
      }),
    });

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
    const result = derive({
      "create-thing": operation({
        ...create,
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
    });

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
    const result = derive({
      "list-things": operation({
        ...named("list"),
        parameters: [
          { name: "ref", in: "path", required: true, schema: { type: "string" } },
          { name: "sort", in: "query", schema: { type: "string", enum: ["asc", "desc"] } },
        ],
        responses: { "204": { description: "none" } },
      }),
    });

    expect(result.problems).toEqual([]);
    expect(result.entries[0]?.flags[0]).toMatchObject({ name: "sort", choices: ["asc", "desc"] });
    expect(result.entries[0]?.response).toEqual({ status: 204, kind: "empty" });
    expect(result.schemas["list-things"]?.result).toEqual({ $schema: DIALECT, type: "null" });
  });

  it("derives a plain token-named query parameter as a flag", () => {
    const result = derive({
      "list-things": operation({
        ...named("list"),
        parameters: [
          { name: "ref", in: "path", required: true, schema: { type: "string" } },
          { name: "page_token", in: "query", schema: { type: "string" } },
        ],
      }),
    });

    expect(result.problems).toEqual([]);
    expect(result.entries[0]?.flags[0]).toMatchObject({ name: "page-token" });
  });

  it("rejects a binary success response", () => {
    const result = derive({
      "create-thing": operation({
        ...create,
        responses: { "200": { description: "file", content: { "application/octet-stream": {} } } },
      }),
    });

    expect(result.entries).toEqual([]);
    expect(result.problems.join("\n")).toContain("binary or streaming");
  });

  describe("body fields without a flag", () => {
    const writeOnlyString = { type: "string", writeOnly: true };
    const nestedBody = (nested: Record<string, unknown>) =>
      derive({
        "create-thing": operation({ ...create, requestBody: envelope({ nested }) }),
      });

    it("keeps the operation and describes the field in the request schema without a flag or binding", () => {
      const result = nestedBody({ type: "object", properties: { size: { type: "string" } } });

      expect(result.problems).toEqual([]);
      const [entry] = result.entries;
      expect(entry?.flags.map((flag) => flag.name)).toEqual(["name"]);
      expect(entry?.bindings.filter((binding) => binding.location === "body")).toHaveLength(1);
      expect(JSON.stringify(result.schemas["create-thing"]?.request)).toContain('"nested"');
    });

    it("rejects a sensitive field that has no flag", () => {
      const result = nestedBody({
        type: "object",
        writeOnly: true,
        properties: { size: { type: "string" } },
      });

      expect(result.entries).toEqual([]);
      expect(result.problems.join("\n")).toContain(
        'unsupported in this runtime: body field "nested" is a secret without a flag',
      );
    });

    it("rejects an unmarked credential-like field that has no flag", () => {
      const result = derive({
        "create-thing": operation({
          ...create,
          requestBody: envelope({ api_key: { type: "object", properties: {} } }),
        }),
      });

      expect(result.problems.join("\n")).toContain('"api_key" looks like a credential');
    });

    it.each([
      [
        "a writeOnly property",
        { type: "object", properties: { size: { type: "string" }, pin: writeOnlyString } },
        "nested.pin",
      ],
      [
        "a credential-like property name",
        { type: "object", properties: { db_password: { type: "string" } } },
        "nested.db_password",
      ],
      [
        "a secret inside array items",
        { type: "array", items: { type: "object", properties: { pin: writeOnlyString } } },
        "nested[].pin",
      ],
      [
        "a secret two levels down",
        {
          type: "object",
          properties: { inner: { type: "object", properties: { pin: writeOnlyString } } },
        },
        "nested.inner.pin",
      ],
      [
        "a secret in an anyOf member",
        { anyOf: [{ type: "object", properties: { pin: writeOnlyString } }, { type: "null" }] },
        "nested.pin",
      ],
    ])("rejects a file-only field that holds %s", (_label, nested, secretPath) => {
      const result = nestedBody(nested);

      expect(result.entries).toEqual([]);
      expect(result.problems).toEqual([
        `create-thing: unsupported in this runtime: body field "nested" holds the secret "${secretPath}" without a flag, and the dry-run preview masks only flag-bound fields`,
      ]);
    });

    it("rejects a file-only field whose patternProperties value is a secret", () => {
      const result = nestedBody({
        type: "object",
        patternProperties: { ".*": { type: "string", format: "password" } },
      });

      expect(result.entries).toEqual([]);
      expect(result.problems).toEqual([
        'create-thing: unsupported in this runtime: body field "nested" is a secret without a flag, and the dry-run preview masks only flag-bound fields',
      ]);
    });

    it("accepts a file-only field whose schema refers back to itself when it holds no secret", () => {
      const node = {
        type: "object",
        properties: { label: { type: "string" }, child: { $ref: "#/components/schemas/Node" } },
      };
      const result = derive(
        {
          "create-thing": operation({
            ...create,
            requestBody: envelope({ tree: { $ref: "#/components/schemas/Node" } }),
          }),
        },
        ["create-thing"],
        { schemas: { Node: node } },
      );

      expect(result.problems.join("\n")).not.toContain("secret");
      expect(result.problems).toEqual([
        "create-thing: unsupported in this runtime: recursive schema reference #/components/schemas/Node",
      ]);
    });
  });

  it("rejects a body field that collides with a reserved runtime flag", () => {
    const result = derive({
      "create-thing": operation({
        ...create,
        requestBody: envelope({ wait: { type: "boolean" } }),
      }),
    });

    expect(result.problems.join("\n")).toContain('"--wait"');
  });

  it("converts OpenAPI 3.0 schema keywords to JSON Schema 2020-12", () => {
    const result = derive({
      "get-thing": operation({
        ...named("get"),
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
    });

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
    const result = derive({
      "get-thing": operation({
        ...named("get"),
        responses: jsonResponse({ type: "string", contentMediaType: "x" }),
      }),
    });

    expect(result.problems.join("\n")).toContain('keyword "contentMediaType"');
  });

  it("names a command from the operation's x-operation", () => {
    const result = derive({ "create-thing": operation(create) });

    expect(result.problems).toEqual([]);
    expect(result.entries.map((entry) => entry.command)).toEqual([["thing", "create"]]);
  });

  it("strips the stage paragraph from the description whatever the stage word", () => {
    const describe = (description: string) =>
      derive({ "create-thing": operation({ ...create, description }) }).entries[0]?.description;

    expect(describe("Does the thing.\n\nThis endpoint is currently in its **Alpha** stage.")).toBe(
      "Does the thing.",
    );
    expect(describe("Does the thing.\n\nThis endpoint is currently in its **Beta** stage.\n")).toBe(
      "Does the thing.",
    );
    expect(describe("This endpoint is currently in its **Alpha** stage.")).toBeUndefined();
  });

  it("generates only operations marked experimental", () => {
    const result = derive({
      "create-thing": operation({ ...create, "x-scalar-stability": "beta" }),
    });

    expect(result.entries).toEqual([]);
    expect(result.problems.join("\n")).toContain("only operations marked experimental");
  });

  it("names array body flags in the singular and keeps other fields as they are", () => {
    const list = { type: "array", items: { type: "string" } };
    const result = derive({
      "create-thing": operation({
        ...create,
        requestBody: envelope({
          categories: list,
          tables: list,
          access: list,
          status: list,
          analysis: list,
          sizes: { type: "string" },
        }),
      }),
    });

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
    const result = derive({
      "create-thing": operation({
        ...create,
        requestBody: envelope({
          table: { type: "string" },
          tables: { type: "array", items: { type: "string" } },
        }),
      }),
    });

    expect(result.problems.join("\n")).toContain('"--table"');
  });

  it("marks writeOnly and password-format body fields sensitive", () => {
    const result = derive({
      "create-thing": operation({
        ...create,
        requestBody: envelope({
          api_secret: { type: "string", writeOnly: true },
          pin: { type: "string", format: "password" },
          recovery_codes: { type: "array", items: { type: "string", writeOnly: true } },
        }),
      }),
    });

    expect(result.problems).toEqual([]);
    expect(result.entries[0]?.flags.map((flag) => [flag.name, flag.sensitive === true])).toEqual([
      ["name", false],
      ["api-secret", true],
      ["pin", true],
      ["recovery-code", true],
    ]);
  });

  it("accepts a credential-like field that is marked x-sensitive and rejects it otherwise", () => {
    const body = (api_key: Record<string, unknown>) => envelope({ api_key });
    const flagOf = (result: ReturnType<typeof derive>) =>
      result.entries[0]?.flags.find((flag) => flag.name === "api-key");

    const marked = derive({
      "create-thing": operation({
        ...create,
        requestBody: body({ type: "string", "x-sensitive": true }),
      }),
    });
    const unmarked = derive({
      "create-thing": operation({ ...create, requestBody: body({ type: "string" }) }),
    });

    expect(marked.problems).toEqual([]);
    expect(flagOf(marked)?.sensitive).toBe(true);
    expect(unmarked.problems.join("\n")).toContain('"api_key" looks like a credential');
  });

  describe("wait from response links", () => {
    const requiredChain = {
      type: "object",
      required: ["data"],
      properties: {
        data: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
      },
    };
    const changeResponse = (
      links: unknown,
      schema: unknown = requiredChain,
      mediaType = "json",
    ) => ({
      "202": {
        description: "accepted",
        content: { [mediaType === "json" ? "application/json" : mediaType]: { schema } },
        links,
      },
    });
    const poll = {
      status: "/data/attributes/status",
      succeeded: ["done"],
      failed: ["broken"],
      error: "/data/attributes/reason",
    };
    const readSchema = {
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
    };
    const readWith = (readPoll: unknown, responses: unknown = jsonResponse(readSchema)) =>
      operation({
        "x-operation": { group: "thing", method: "get", poll: readPoll },
        parameters: [
          { name: "ref", in: "path", required: true, schema: { type: "string" } },
          { name: "thing_id", in: "query", schema: { type: "string" } },
        ],
        responses,
      });
    const readThing = readWith(poll);
    const link = (parameters: Record<string, string>, operationId = "get-thing") => ({
      setup: { operationId, parameters },
    });
    const changeThing = (links: unknown, schema?: unknown) =>
      operation({ ...create, responses: changeResponse(links, schema) });
    const waitOf = (result: ReturnType<typeof derive>) =>
      result.entries.find((entry) => entry.operationId === "create-thing")?.wait;
    const inspectThing = operation(named("status"));
    /** `create-thing` and an inspect command are generated; each listed polling target stays hidden. */
    const deriveHidden = (
      operations: Record<string, unknown>,
      targets: Record<string, string> = { "get-thing": "get-inspect" },
      inspect: unknown = inspectThing,
    ) =>
      derive({ ...operations, "get-inspect": inspect }, ["create-thing", "get-inspect"], {
        overrides: { pollTargets: targets },
      });

    it("builds the wait from the polled target and leaves the shared path parameter to the runtime", () => {
      const result = derive({
        "create-thing": changeThing(
          link({ ref: "$request.path.ref", thing_id: "$response.body#/data/id" }),
        ),
        "get-thing": readThing,
      });

      expect(result.problems).toEqual([]);
      expect(waitOf(result)).toEqual({
        read: "get-thing",
        params: { thing_id: "/data/id" },
        ...poll,
      });
    });

    it("resolves wait pointers from +json responses", () => {
      const jsonApi = (schema: unknown) => ({
        "200": { description: "ok", content: { "application/vnd.api+json": { schema } } },
      });
      const result = derive({
        "create-thing": operation({
          ...create,
          responses: changeResponse(
            link({ thing_id: "$response.body#/data/id" }),
            requiredChain,
            "application/vnd.api+json",
          ),
        }),
        "get-thing": readWith(poll, jsonApi(readSchema)),
      });

      expect(result.problems).toEqual([]);
      expect(waitOf(result)?.read).toBe("get-thing");
    });

    it("resolves escaped status and error pointers against property names", () => {
      const escapedRead = {
        type: "object",
        properties: {
          "a/b": { type: "string", enum: ["done", "broken"] },
          "c~d": { type: "string" },
        },
      };
      const result = derive({
        "create-thing": changeThing(link({ thing_id: "$response.body#/data/id" })),
        "get-thing": readWith(
          { ...poll, status: "/a~1b", error: "/c~0d" },
          jsonResponse(escapedRead),
        ),
      });

      expect(result.problems).toEqual([]);
      expect(waitOf(result)).toMatchObject({ status: "/a~1b", error: "/c~0d" });
    });

    it("accepts a link parameter pointing at a required property with escaped characters", () => {
      const escapedChange = {
        type: "object",
        required: ["a~/b"],
        properties: { "a~/b": { type: "string" } },
      };
      const result = derive(
        {
          "create-thing": changeThing(link({ thing_id: "$response.body#/a~0~1b" }), escapedChange),
          "get-thing": readThing,
        },
        ["create-thing", "get-thing"],
      );

      expect(result.problems).toEqual([]);
    });

    it("ignores a link whose target has no poll", () => {
      const result = derive({
        "create-thing": changeThing(link({})),
        "get-thing": operation(named("get")),
      });

      expect(result.problems).toEqual([]);
      expect(waitOf(result)).toBeUndefined();
    });

    it("keeps a listed polling target internal and records the command that inspects it", () => {
      const result = deriveHidden({
        "create-thing": changeThing(
          link({ ref: "$request.path.ref", thing_id: "$response.body#/data/id" }),
        ),
        "get-thing": readThing,
      });

      expect(result.problems).toEqual([]);
      expect(result.entries.map((entry) => entry.command)).toEqual([
        ["thing", "create"],
        ["thing", "status"],
      ]);
      expect(waitOf(result)).toEqual({
        read: "get-thing",
        params: { thing_id: "/data/id" },
        ...poll,
      });
      expect(result.pollTargets).toEqual([
        {
          operationId: "get-thing",
          definition: "v2EnableWarehouse",
          summary: "Do the thing",
          response: { status: 200, kind: "json" },
          inspect: "get-inspect",
        },
      ]);
      expect(result.schemas["get-thing"]?.result).toEqual({ $schema: DIALECT, ...readSchema });
    });

    it("rejects a link to a polled operation that is neither generated nor listed", () => {
      const result = derive({ "create-thing": changeThing(link({})), "get-thing": readThing }, [
        "create-thing",
      ]);

      expect(result.problems.join("\n")).toContain(
        'targets polled operation "get-thing", which is neither generated nor listed in pollTargets',
      );
      expect(result.pollTargets).toEqual([]);
    });

    it("rejects a listed polling target that no generated operation links to", () => {
      const result = deriveHidden({
        "create-thing": operation(create),
        "get-thing": readThing,
      });

      expect(result.problems).toEqual([
        "get-thing: polling target is not linked from any generated operation; remove it from pollTargets",
      ]);
    });

    it("rejects a listed polling target that is also generated", () => {
      const result = derive(
        { "create-thing": changeThing(link({})), "get-thing": readThing },
        ["create-thing", "get-thing", "get-inspect"],
        { overrides: { pollTargets: { "get-thing": "get-inspect" } } },
      );

      expect(result.problems.join("\n")).toContain(
        "get-thing: polling target is also a generated operation",
      );
    });

    it("rejects an inspect command that needs input beyond the project ref", () => {
      const result = deriveHidden(
        { "create-thing": changeThing(link({})), "get-thing": readThing },
        { "get-thing": "get-inspect" },
        operation({
          ...named("status"),
          parameters: [
            { name: "ref", in: "path", required: true, schema: { type: "string" } },
            { name: "id", in: "path", required: true, schema: { type: "string" } },
          ],
        }),
      );

      expect(result.problems).toEqual([
        'get-thing: inspect operation "get-inspect" needs input beyond the project ref',
      ]);
    });

    it("rejects an inspect command that changes state", () => {
      const result = derive(
        {
          "create-thing": changeThing(link({})),
          "get-thing": readThing,
          "reset-thing": operation(named("delete")),
        },
        ["create-thing", "reset-thing"],
        { overrides: { pollTargets: { "get-thing": "reset-thing" } } },
      );

      expect(result.problems).toEqual([
        'get-thing: inspect operation "reset-thing" must be a read-only command',
      ]);
    });

    it("rejects an inspect operation that is not generated", () => {
      const result = deriveHidden(
        { "create-thing": changeThing(link({})), "get-thing": readThing },
        { "get-thing": "get-missing" },
      );

      expect(result.problems.join("\n")).toContain(
        'inspect operation "get-missing" is not a generated operation',
      );
    });

    it("rejects a listed polling target that declares poll and also links to a polled operation", () => {
      const result = deriveHidden(
        {
          "create-thing": changeThing(link({})),
          "get-thing": operation({
            ...readThing,
            responses: {
              "200": { ...jsonResponse(readSchema)["200"], links: link({}, "get-other") },
            },
          }),
          "get-other": readThing,
        },
        { "get-thing": "get-inspect", "get-other": "get-inspect" },
      );

      expect(result.problems.join("\n")).toContain(
        'get-thing: declares poll and also links to the polled operation "get-other"; use one',
      );
    });

    it("rejects a listed polling target that is not experimental", () => {
      const result = deriveHidden({
        "create-thing": changeThing(link({})),
        "get-thing": { ...readThing, "x-scalar-stability": "stable" },
      });

      expect(result.problems).toEqual([
        "get-thing: only operations marked experimental can be generated (x-scalar-stability)",
      ]);
    });

    it.each([
      ["a mutation", "update-thing", readThing, "must use GET"],
      [
        "a request body",
        "get-thing",
        { ...readThing, requestBody: envelope({}) },
        "must not require a request body",
      ],
      [
        "no project scope",
        "get-thing",
        { ...readThing, parameters: [] },
        "must be scoped by a project ref path parameter",
      ],
      [
        "invalid poll metadata",
        "get-thing",
        readWith({ ...poll, succeeded: "done" }),
        "invalid x-operation",
      ],
    ] as const)("rejects a listed polling target with %s", (_label, id, read, message) => {
      const result = deriveHidden(
        { "create-thing": changeThing(link({}, id)), [id]: read },
        {
          [id]: "get-inspect",
        },
      );

      expect(result.problems.join("\n")).toContain(message);
      expect(result.pollTargets).toEqual([]);
    });

    it("rejects a listed polling target missing from the typed client", () => {
      const result = derive(
        {
          "create-thing": changeThing(link({})),
          "get-thing": readThing,
          "get-inspect": inspectThing,
        },
        ["create-thing", "get-inspect"],
        {
          overrides: {
            pollTargets: { "get-thing": "get-inspect" },
            operationIdMap: {
              "create-thing": "v2EnableWarehouse",
              "get-inspect": "v2EnableWarehouse",
            },
          },
        },
      );

      expect(result.problems).toEqual([
        "get-thing: polling target is missing from the typed client; regenerate @supabase/api",
      ]);
    });

    it("derives a self wait on a read that declares its own poll", () => {
      const result = derive({ "get-thing": readThing });

      expect(result.problems).toEqual([]);
      expect(result.entries[0]?.wait).toEqual({ read: "get-thing", params: {}, ...poll });
    });

    it("rejects a read that declares poll and also links to a polled operation", () => {
      const result = derive({
        "get-thing": readThing,
        "get-other": operation({
          ...readThing,
          responses: {
            "200": {
              description: "ok",
              content: { "application/json": { schema: requiredChain } },
              links: link({ thing_id: "$response.body#/data/id" }),
            },
          },
        }),
      });

      expect(result.problems.join("\n")).toContain(
        'declares poll and also links to the polled operation "get-thing"; use one',
      );
    });

    it("rejects a poll status pointer that does not resolve in the read response", () => {
      const result = derive({
        "create-thing": changeThing(link({ thing_id: "$response.body#/data/id" })),
        "get-thing": readWith({ ...poll, status: "/data/attributes/missing" }),
      });

      expect(result.problems.join("\n")).toContain(
        'wait.status pointer "/data/attributes/missing"',
      );
    });

    it.each([
      [
        "an error pointer the read response does not have",
        readWith({ ...poll, error: "/data/attributes/nope" }),
        'wait.error pointer "/data/attributes/nope" does not resolve in the get-thing response',
      ],
      [
        "an empty succeeded list",
        readWith({ ...poll, succeeded: [] }),
        "wait.succeeded must list at least one status",
      ],
      [
        "a status outside the status enum",
        readWith({ ...poll, failed: ["bogus"] }),
        'wait status "bogus" is not in the status enum of get-thing',
      ],
      [
        "a required read parameter the link does not supply",
        operation({
          ...readThing,
          parameters: [
            { name: "ref", in: "path", required: true, schema: { type: "string" } },
            { name: "thing_id", in: "query", required: true, schema: { type: "string" } },
          ],
        }),
        'wait.params does not supply required parameter "thing_id" of get-thing',
      ],
    ])("rejects a poll with %s", (_label, read, message) => {
      const result = deriveHidden({ "create-thing": changeThing(link({})), "get-thing": read });

      expect(result.problems.map((problem) => problem.replace(/^[^:]+: /u, ""))).toContain(message);
    });

    it.each([
      [
        "an unsupported expression",
        link({ thing_id: "$request.query.id" }),
        "unsupported expression",
      ],
      ["an unknown target", link({}, "get-missing"), 'unknown operation "get-missing"'],
      [
        "a request path expression other than ref",
        link({ ref: "$request.path.other" }),
        'link "setup" parameter "ref": only "$request.path.ref" is supported in this runtime',
      ],
      [
        "a link without a target operationId",
        { setup: { parameters: {} } },
        'link "setup" must name its target with operationId',
      ],
      [
        "a ref expression bound to a parameter of another name",
        link({ other: "$request.path.ref" }),
        'link "setup" parameter "other": "$request.path.ref" needs a path parameter of that name on both operations',
      ],
      [
        "a parameter the polled read does not take",
        link({ bogus: "$response.body#/data/id" }),
        'wait.params "bogus" is not a query or path parameter of get-thing',
      ],
      [
        "a pointer the change response does not have",
        link({ thing_id: "$response.body#/data/missing" }),
        'wait.params "thing_id" pointer "/data/missing" does not resolve in the response',
      ],
      [
        "two links to a polled operation",
        { first: link({}).setup, second: link({}).setup },
        "more than one response link targets a polled operation (get-thing, get-thing)",
      ],
    ])("rejects %s", (_label, links, message) => {
      const result = derive({ "create-thing": changeThing(links), "get-thing": readThing });

      expect(result.problems.join("\n")).toContain(message);
    });

    it.each([
      [
        "a property that is not required in the enclosing object",
        {
          type: "object",
          required: ["data"],
          properties: { data: { type: "object", properties: { id: { type: "string" } } } },
        },
      ],
      [
        "an enclosing object that is not required",
        {
          type: "object",
          properties: {
            data: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
          },
        },
      ],
      [
        "a required property that is nullable",
        {
          type: "object",
          required: ["data"],
          properties: {
            data: {
              type: "object",
              required: ["id"],
              properties: { id: { type: "string", nullable: true } },
            },
          },
        },
      ],
    ])("rejects a wait value taken from %s", (_label, schema) => {
      const result = derive({
        "create-thing": changeThing(link({ thing_id: "$response.body#/data/id" }), schema),
        "get-thing": readThing,
      });

      expect(waitOf(result)).toBeUndefined();
      expect(result.problems.join("\n")).toContain("is not required at every level");
    });
  });

  describe("nested groups", () => {
    it("derives a command path from a dotted group, three levels deep", () => {
      const result = derive({
        "create-thing": operation({ "x-operation": { group: "thing.sub", method: "create" } }),
        "create-deep": operation({ "x-operation": { group: "thing.sub.deep", method: "create" } }),
      });

      expect(result.problems).toEqual([]);
      expect(result.entries.map((entry) => entry.command)).toEqual([
        ["thing", "sub", "create"],
        ["thing", "sub", "deep", "create"],
      ]);
    });
  });

  describe("path parameters", () => {
    const withParameters = (...parameters: ReadonlyArray<unknown>) =>
      operation({
        "x-operation": { group: "thing", method: "get" },
        parameters: [
          { name: "ref", in: "path", required: true, schema: { type: "string" } },
          ...parameters,
        ],
      });
    const pathParameter = (name: string, extra: Record<string, unknown> = {}) => ({
      name,
      in: "path",
      required: true,
      schema: { type: "string" },
      ...extra,
    });

    it("binds the one other path parameter to a positional argument named after it", () => {
      const result = derive({
        "get-thing": withParameters(
          pathParameter("function_slug", { description: "Slug of the function." }),
        ),
      });

      expect(result.problems).toEqual([]);
      const [entry] = result.entries;
      expect(entry?.argument).toEqual({
        name: "function-slug",
        description: "Slug of the function.",
      });
      expect(entry?.bindings).toEqual([
        { location: "path", name: "ref", source: "target" },
        { location: "path", name: "function_slug", source: "argument", argument: "function-slug" },
      ]);
      expect(entry?.flags).toEqual([]);
    });

    it.each([
      [
        "a second path parameter",
        withParameters(pathParameter("version"), pathParameter("id")),
        'unsupported in this runtime: more than one path parameter besides "ref"',
      ],
      [
        "a path parameter that is not a scalar",
        withParameters(
          pathParameter("version", { schema: { type: "array", items: { type: "string" } } }),
        ),
        'path parameter "version" is not a scalar',
      ],
      [
        "a path parameter that is not a string",
        withParameters(pathParameter("version", { schema: { type: "integer" } })),
        'unsupported in this runtime: path parameter "version" is not a string',
      ],
      [
        "a path parameter named like a query parameter",
        withParameters(pathParameter("version"), {
          name: "version",
          in: "query",
          schema: { type: "string" },
        }),
        '"version" is used by more than one of',
      ],
      [
        "a path parameter that stands in for no ref",
        operation({
          "x-operation": { group: "thing", method: "get" },
          parameters: [pathParameter("version")],
        }),
        'operation has no "ref" path parameter',
      ],
    ])("rejects %s", (_label, node, message) => {
      const result = derive({ "get-thing": node });

      expect(result.problems.join("\n")).toContain(message);
    });
  });

  describe("header parameters", () => {
    const withHeaders = (...headers: ReadonlyArray<unknown>) =>
      operation({
        ...create,
        parameters: [
          { name: "ref", in: "path", required: true, schema: { type: "string" } },
          ...headers,
        ],
      });
    const header = (name: string, extra: Record<string, unknown> = {}) => ({
      name,
      in: "header",
      schema: { type: "string" },
      ...extra,
    });

    it("turns a header parameter into a flag that is required only when the header is", () => {
      const result = derive({
        "create-thing": withHeaders(
          header("Idempotency-Key", { description: "Deduplicates retries." }),
          header("X-Trace-Id", { required: true }),
        ),
      });

      expect(result.problems).toEqual([]);
      const [entry] = result.entries;
      expect(entry?.flags).toEqual([
        {
          name: "idempotency-key",
          type: "string",
          repeatable: false,
          required: false,
          description: "Deduplicates retries.",
        },
        { name: "x-trace-id", type: "string", repeatable: false, required: true },
      ]);
      expect(entry?.bindings).toContainEqual({
        location: "header",
        name: "Idempotency-Key",
        source: "flag",
        flag: "idempotency-key",
      });
    });

    it.each([
      ["a credential-named header", header("X-Api-Key")],
      [
        "a password-format header",
        header("X-Pin", { schema: { type: "string", format: "password" } }),
      ],
    ])("rejects %s because the dry-run preview masks only body fields", (_label, parameter) => {
      const result = derive({ "create-thing": withHeaders(parameter) });

      expect(result.entries).toEqual([]);
      expect(result.problems).toEqual([
        `create-thing: unsupported in this runtime: header parameter "${parameter.name}" carries a credential, and the dry-run preview masks only body fields`,
      ]);
    });

    it("gives no flag to Authorization, Content-Type or Accept in any case", () => {
      const result = derive({
        "create-thing": withHeaders(
          header("Authorization"),
          header("content-type"),
          header("ACCEPT"),
        ),
      });

      expect(result.problems).toEqual([]);
      expect(result.entries[0]?.flags).toEqual([]);
    });

    it.each([
      [
        "a cookie parameter",
        { name: "session", in: "cookie", schema: { type: "string" } },
        'unsupported in this runtime: cookie parameter "session"',
      ],
      [
        "a header that is not a scalar",
        header("X-Tags", { schema: { type: "array", items: { type: "string" } } }),
        'header parameter "X-Tags" is not a scalar',
      ],
      ["a header named like a body field", header("name"), '"name" is used by more than one of'],
    ])("rejects %s", (_label, parameter, message) => {
      const result = derive({
        "create-thing": operation({
          ...create,
          requestBody: envelope({}),
          parameters: [
            { name: "ref", in: "path", required: true, schema: { type: "string" } },
            parameter,
          ],
        }),
      });

      expect(result.problems.join("\n")).toContain(message);
    });
  });

  it.each([
    [
      "a command of more than four words",
      {
        "create-thing": operation({
          "x-operation": { group: "thing.sub.deep.deeper", method: "create" },
        }),
      },
      'command "thing sub deep deeper create" has more than four words',
    ],
    [
      "a sub-group without a description",
      { "create-thing": operation({ "x-operation": { group: "thing.other", method: "create" } }) },
      'group "other" has no description in the nouns table',
    ],
    [
      "a leaf command that is also a group",
      {
        "get-status": operation({ "x-operation": { group: "thing", method: "status" } }),
        "get-detail": operation({ "x-operation": { group: "thing.status", method: "get" } }),
      },
      'command "thing status" is both a command and a group',
    ],
    [
      "an operation without a ref path parameter",
      { "create-thing": operation({ ...create, parameters: [] }) },
      'operation has no "ref" path parameter',
    ],
    [
      "a verb outside the vocabulary",
      { "create-thing": operation({ "x-operation": { group: "thing", method: "frobnicate" } }) },
      'verb "frobnicate" is outside the vocabulary',
    ],
    [
      "an unknown key in x-operation",
      {
        "create-thing": operation({
          "x-operation": { group: "thing", method: "create", bogus: 1 },
        }),
      },
      "create-thing: invalid x-operation",
    ],
    [
      "a generated operation that has no x-operation",
      { "create-thing": operation({}) },
      "create-thing: no command name",
    ],
  ])("rejects %s", (_label, operations, message) => {
    const result = derive(operations);

    expect(result.problems.join("\n")).toContain(message);
  });

  describe("operation rejections", () => {
    const ref = { name: "ref", in: "path", required: true, schema: { type: "string" } };
    const withParameters = (...parameters: ReadonlyArray<unknown>) =>
      operation({ ...create, parameters: [ref, ...parameters] });
    const respondWith = (schema: unknown) =>
      operation({ ...named("get"), responses: jsonResponse(schema) });

    it.each([
      [
        "a response schema that is not an object",
        { "get-thing": respondWith({ type: "object", properties: { a: 5 } }) },
        "get-thing: schema is not an object",
      ],
      [
        "a response schema reference that does not resolve",
        { "get-thing": respondWith({ $ref: "#/components/schemas/Missing" }) },
        "get-thing: schema reference #/components/schemas/Missing does not resolve",
      ],
      [
        "an exclusive bound without its bound",
        { "get-thing": respondWith({ type: "integer", exclusiveMinimum: true }) },
        "get-thing: schema sets exclusiveMinimum: true without minimum",
      ],
      [
        "an exclusive bound with an unsupported value",
        { "get-thing": respondWith({ type: "integer", exclusiveMaximum: "yes" }) },
        'get-thing: schema keyword "exclusiveMaximum" has an unsupported value',
      ],
      [
        "a nullable keyword with an unsupported value",
        { "get-thing": respondWith({ type: "string", nullable: "yes" }) },
        'get-thing: schema keyword "nullable" has an unsupported value',
      ],
      [
        "a response status that is not a number",
        { "create-thing": operation({ ...create, responses: { "2XX": { description: "ok" } } }) },
        'create-thing: unsupported in this runtime: response status "2XX"',
      ],
      [
        "an operation with no 2xx response",
        {
          "create-thing": operation({ ...create, responses: { "400": { description: "bad" } } }),
        },
        "create-thing: operation has no 2xx response",
      ],
      [
        "a noun missing from the nouns table",
        { "create-thing": operation({ "x-operation": { group: "other", method: "create" } }) },
        'create-thing: noun "other" is missing from the nouns table',
      ],
      [
        "a command that is not lowercase kebab-case",
        { "create-thing": operation({ "x-operation": { group: "thing", method: "Create" } }) },
        'create-thing: command "thing Create" must be lowercase kebab-case words',
      ],
      [
        "a command generated twice",
        { "create-thing": operation(create), "create-other": operation(create) },
        'create-other: command "thing create" is already generated by create-thing',
      ],
      [
        "a command declared after the group that contains it",
        {
          "get-detail": operation({ "x-operation": { group: "thing.status", method: "get" } }),
          "get-status": operation({ "x-operation": { group: "thing", method: "status" } }),
        },
        'get-status: command "thing status" is both a command and a group',
      ],
      [
        "a poll on an operation that is not a read",
        {
          "create-thing": operation({
            "x-operation": {
              group: "thing",
              method: "create",
              poll: { status: "/ok", succeeded: ["done"], failed: [] },
            },
          }),
        },
        "create-thing: poll belongs on a read operation, not POST",
      ],
      [
        "an operation with no summary",
        { "create-thing": operation({ ...create, summary: undefined }) },
        "create-thing: operation has no summary",
      ],
      [
        "a server-side dry_run query parameter",
        {
          "create-thing": withParameters({
            name: "dry_run",
            in: "query",
            schema: { type: "boolean" },
          }),
        },
        'create-thing: unsupported in this runtime: server-side "dry_run" parameter',
      ],
      [
        "a query parameter that is not a scalar",
        {
          "create-thing": withParameters({
            name: "filter",
            in: "query",
            schema: { type: "object" },
          }),
        },
        'create-thing: unsupported in this runtime: query parameter "filter" is not a scalar',
      ],
      [
        "a secret query parameter",
        {
          "create-thing": withParameters({
            name: "pin",
            in: "query",
            schema: { type: "string", writeOnly: true },
          }),
        },
        'create-thing: unsupported in this runtime: query parameter "pin" is a secret, and the dry-run preview masks only body fields',
      ],
      [
        "a query parameter whose flag is not kebab-case",
        {
          "create-thing": withParameters({
            name: "page.size",
            in: "query",
            schema: { type: "string" },
          }),
        },
        'create-thing: flag "page.size" must be lowercase kebab-case',
      ],
      [
        "a path parameter whose argument is not kebab-case",
        {
          "create-thing": withParameters({
            name: "slug.name",
            in: "path",
            required: true,
            schema: { type: "string" },
          }),
        },
        'create-thing: argument "slug.name" must be lowercase kebab-case',
      ],
      [
        "a request body that is not JSON",
        {
          "create-thing": operation({
            ...create,
            requestBody: { content: { "text/plain": { schema: { type: "string" } } } },
          }),
        },
        "create-thing: unsupported in this runtime: request body (text/plain) is not a JSON object",
      ],
      [
        "a server-side dry_run body field",
        {
          "create-thing": operation({
            ...create,
            requestBody: envelope({ dry_run: { type: "boolean" } }),
          }),
        },
        'create-thing: unsupported in this runtime: server-side "dry_run" body field',
      ],
      [
        "a file-only body field named like a path parameter",
        {
          "create-thing": operation({
            ...create,
            parameters: [
              ref,
              { name: "version", in: "path", required: true, schema: { type: "string" } },
            ],
            requestBody: envelope({ version: { type: "object", properties: {} } }),
          }),
        },
        'create-thing: "version" is used by more than one of: path parameter, header parameter, query parameter, body field',
      ],
    ])("rejects %s", (_label, operations, problem) => {
      const result = derive(operations);

      expect(result.problems).toContain(problem);
    });

    it("rejects an operation that the typed client does not have", () => {
      const result = derive({ "create-thing": operation(create) }, undefined, {
        overrides: { operationIdMap: {} },
      });

      expect(result.problems).toEqual([
        "create-thing: operation is missing from the typed client; regenerate @supabase/api",
      ]);
    });

    it("rejects a command whose first word belongs to a hand-written command", () => {
      const result = derive({ "create-thing": operation(create) }, undefined, {
        overrides: { handWrittenTopLevel: new Set(["thing"]) },
      });

      expect(result.problems).toEqual([
        'create-thing: command "thing create" collides with the hand-written "thing" command',
      ]);
    });
  });

  describe("generated operations", () => {
    const named = operation({ "x-operation": { group: "thing", method: "create" } });

    it("ignores x-operation on an operation that is not generated, even when it is invalid", () => {
      const result = derive(
        {
          "create-thing": named,
          "create-other": operation({
            "x-operation": { group: "other", method: "frobnicate", bogus: 1 },
          }),
        },
        ["create-thing"],
      );

      expect(result.problems).toEqual([]);
      expect(result.entries.map((entry) => entry.operationId)).toEqual(["create-thing"]);
    });

    it("rejects a generated operation that is missing from the spec", () => {
      const result = derive({ "create-thing": named }, ["create-thing", "missing-thing"]);

      expect(result.problems).toEqual([
        "missing-thing: generated operation has no operation in the spec",
      ]);
    });
  });
});
