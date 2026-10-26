import type { ErrorObject, ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020";
import { Schema } from "effect";
import { describe, expect, test } from "vitest";
import { CliConfigSchema, toCliConfigJsonSchema } from "./base.ts";
import { toPublishedJsonSchemaDocument } from "./json-schema-document.ts";
import {
  ENV_PATTERN,
  env,
  interpolateEnvReferencesAgainstSchema,
  isEnvReference,
} from "./lib/env.ts";
import { secretPathPatterns } from "./lib/secret-paths.ts";
import { toProjectConfigJsonSchema } from "./project-config/project-schema.ts";

type Node = Record<string, unknown>;

const at = (node: unknown, ...path: ReadonlyArray<string | number>): Node => {
  let current: unknown = node;
  for (const key of path) current = (current as Record<string | number, unknown>)[key];
  return current as Node;
};

const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const DATA_KEYWORDS = new Set(["default", "examples", "enum", "const"]);
const SCHEMA_MAP_KEYWORDS = new Set(["properties", "patternProperties", "$defs"]);
const COERCED_TYPES = new Set(["number", "integer", "boolean"]);

type Path = ReadonlyArray<string | number>;

const visitSchemas = (
  node: unknown,
  visit: (node: Node, path: Path, siblings: ReadonlyArray<unknown> | undefined) => void,
  path: Path = [],
  siblings?: ReadonlyArray<unknown>,
): void => {
  if (!isNode(node)) return;
  visit(node, path, siblings);
  for (const [keyword, value] of Object.entries(node)) {
    if (DATA_KEYWORDS.has(keyword)) continue;
    if (SCHEMA_MAP_KEYWORDS.has(keyword) && isNode(value)) {
      for (const [name, child] of Object.entries(value)) {
        visitSchemas(child, visit, [...path, keyword, name]);
      }
    } else if (Array.isArray(value)) {
      value.forEach((child, index) => {
        visitSchemas(
          child,
          visit,
          [...path, keyword, index],
          keyword === "anyOf" ? value : undefined,
        );
      });
    } else {
      visitSchemas(value, visit, [...path, keyword]);
    }
  }
};

const isEnvBranch = (node: unknown): boolean =>
  isNode(node) &&
  node.type === "string" &&
  typeof node.pattern === "string" &&
  Object.keys(node).length === 2;

const isEnvReferenceLeaf = (node: Node): boolean =>
  typeof node.type === "string" &&
  (COERCED_TYPES.has(node.type) || (node.type === "string" && Array.isArray(node.enum)));

const collectEnvBranches = (document: unknown): Array<Node> => {
  const found: Array<Node> = [];
  visitSchemas(document, (node, _path, siblings) => {
    if (siblings !== undefined && isEnvBranch(node)) found.push(node);
  });
  return found;
};

const findEnvReferenceGaps = (document: unknown) => {
  const gaps: Array<string> = [];
  let leaves = 0;
  visitSchemas(document, (node, path, siblings) => {
    const where = path.join(".");
    if (isEnvReferenceLeaf(node)) {
      leaves += 1;
      const branches = siblings?.filter(isEnvBranch).length ?? 0;
      if (branches !== 1) gaps.push(`${where}: ${branches} env branches next to ${node.type}`);
    }
    if (Array.isArray(node.anyOf) && node.anyOf.filter(isEnvBranch).length > 1) {
      gaps.push(`${where}: more than one env branch in the same anyOf`);
    }
  });
  return { gaps, leaves };
};

const patternOf = (node: Node): string => {
  if (typeof node.pattern !== "string") throw new Error("expected the node to carry a pattern");
  return node.pattern;
};

// $schema is dropped so the tests do not depend on which draft the header names.
const compile = (document: Node): ValidateFunction => {
  const schema = Object.fromEntries(Object.entries(document).filter(([key]) => key !== "$schema"));
  return new Ajv2020({ strict: false }).compile(schema);
};

const errorsFor = (validate: ValidateFunction, value: unknown): ReadonlyArray<ErrorObject> =>
  validate(value) ? [] : [...(validate.errors ?? [])];

const failingPaths = (validate: ValidateFunction, value: unknown): ReadonlyArray<string> => [
  ...new Set(errorsFor(validate, value).map((error) => error.instancePath)),
];

const envPatternOf = (document: Node): string =>
  patternOf(at(document, "properties", "api", "properties", "max_rows", "anyOf", 1));

const collectSecretPaths = (document: unknown): Array<string> => {
  const found = new Set<string>();
  const visit = (node: unknown, path: ReadonlyArray<string>): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item, path);
      return;
    }
    if (!isNode(node)) return;
    if (node["x-secret"] === true) found.add(path.join("."));
    for (const [keyword, value] of Object.entries(node)) {
      if (keyword === "properties" && isNode(value)) {
        for (const [name, child] of Object.entries(value)) visit(child, [...path, name]);
      } else if (keyword === "patternProperties" && isNode(value)) {
        for (const child of Object.values(value)) visit(child, [...path, "*"]);
      } else if (keyword === "additionalProperties") {
        visit(value, [...path, "*"]);
      } else if (keyword === "anyOf" || keyword === "oneOf" || keyword === "allOf") {
        visit(value, path);
      }
    }
  };
  visit(document, []);
  return [...found].sort();
};

describe("published JSON Schema documents", () => {
  test("pattern-keyed records stay open while structs stay closed", () => {
    const cli = toCliConfigJsonSchema();
    const functions = at(cli, "properties", "functions", "anyOf", 0);
    expect(Object.keys(functions.patternProperties as Node)).toHaveLength(1);
    expect(functions).not.toHaveProperty("additionalProperties");
    expect(at(cli, "properties", "api")).toHaveProperty("additionalProperties", false);

    const project = toProjectConfigJsonSchema();
    expect(at(project, "properties", "compute")).not.toHaveProperty("additionalProperties");
  });

  test("empty bucket tables render as object or array", () => {
    const project = toProjectConfigJsonSchema();
    const buckets = at(
      project,
      "properties",
      "storage",
      "properties",
      "analytics",
      "properties",
      "buckets",
    );
    expect(buckets.additionalProperties).toEqual({
      anyOf: [{ type: "object" }, { type: "array" }],
    });
  });

  test("the CLI schema marks exactly the secret paths the schema declares", () => {
    const declared = secretPathPatterns.map((pattern) => pattern.join(".")).sort();
    expect(declared).not.toHaveLength(0);
    expect(collectSecretPaths(toCliConfigJsonSchema())).toEqual(declared);
  });

  test("the project config schema carries no secret markers", () => {
    expect(JSON.stringify(toProjectConfigJsonSchema())).not.toContain('"x-secret"');
  });

  test("custom annotations other than x-secret are not published", () => {
    const deferredSecret = toPublishedJsonSchemaDocument(
      Schema.Struct({ token: env({ secret: true }) }),
      { onExcessProperty: "error" },
    );
    expect(collectSecretPaths(deferredSecret)).toEqual(["token"]);
    expect(JSON.stringify(deferredSecret)).not.toContain("x-env-deferred");
    expect(JSON.stringify(toCliConfigJsonSchema())).not.toContain("x-env-deferred");
  });
});

describe("env() references in the published CLI JSON Schema", () => {
  const cli = toCliConfigJsonSchema();
  const validateCli = compile(cli);

  const baseline = {
    project_id: "demo",
    api: { port: 54321, max_rows: 1000 },
    auth: { enable_signup: true },
    db: { settings: { max_connections: 100 } },
    compute: { web: { instances: 2 } },
    storage: { file_size_limit: "50MiB" },
    remotes: { staging: { api: { max_rows: 500 }, compute: { web: { instances: 4 } } } },
  };

  describe("validation", () => {
    test("a document of plain literals validates", () => {
      expect(errorsFor(validateCli, baseline)).toEqual([]);
    });

    test.each([
      ["api.max_rows", { api: { max_rows: "env(MAX_ROWS)" } }],
      ["api.port", { api: { port: "env(API_PORT)" } }],
      ["auth.enable_signup", { auth: { enable_signup: "env(ENABLE_SIGNUP)" } }],
      ["db.settings.max_connections", { db: { settings: { max_connections: "env(MAX_CONN)" } } }],
      ["compute.<name>.instances", { compute: { web: { instances: "env(WEB_INSTANCES)" } } }],
      ["storage.file_size_limit", { storage: { file_size_limit: "env(FILE_SIZE_LIMIT)" } }],
      ["db.pooler.pool_mode", { db: { pooler: { pool_mode: "env(POOL_MODE)" } } }],
      ["realtime.ip_version", { realtime: { ip_version: "env(IP_VERSION)" } }],
      ["remotes.<name>.api.max_rows", { remotes: { staging: { api: { max_rows: "env(ROWS)" } } } }],
      [
        "remotes.<name>.auth.enable_signup",
        { remotes: { staging: { auth: { enable_signup: "env(SIGNUP)" } } } },
      ],
      [
        "remotes.<name>.compute.<name>.instances",
        { remotes: { staging: { compute: { web: { instances: "env(WEB)" } } } } },
      ],
    ])("accepts env() on %s", (_field, document) => {
      expect(errorsFor(validateCli, document)).toEqual([]);
    });

    test.each([
      ["a numeric string in a number field", { api: { max_rows: "1000" } }, "/api/max_rows"],
      ["a word in a boolean field", { auth: { enable_signup: "yes" } }, "/auth/enable_signup"],
      ["an unclosed env() reference", { api: { port: "env(PORT" } }, "/api/port"],
      [
        "an env() reference with leading whitespace",
        { auth: { enable_signup: " env(X)" } },
        "/auth/enable_signup",
      ],
      ["a boolean in a number field", { api: { max_rows: true } }, "/api/max_rows"],
      [
        "an unknown value in an enum field",
        { db: { pooler: { pool_mode: "statement" } } },
        "/db/pooler/pool_mode",
      ],
      [
        "a fractional count in an integer field",
        { compute: { web: { instances: 1.5 } } },
        "/compute/web/instances",
      ],
      [
        "a negative count in a field with a minimum",
        { compute: { web: { instances: -1 } } },
        "/compute/web/instances",
      ],
      [
        "a mistyped literal under a remote",
        { remotes: { staging: { api: { port: "env(PORT" } } } },
        "/remotes/staging/api/port",
      ],
      [
        "a boolean in the string-or-number union",
        { storage: { file_size_limit: true } },
        "/storage/file_size_limit",
      ],
    ])("rejects %s", (_scenario, document, path) => {
      expect(validateCli(document)).toBe(false);
      expect(failingPaths(validateCli, document)).toContain(path);
    });
  });

  describe("published structure", () => {
    test("keeps hover docs on the outer node and the type in the first branch", () => {
      const maxRows = at(cli, "properties", "api", "properties", "max_rows");
      expect(maxRows.description).toMatch(/maximum number of rows/);
      expect(maxRows.default).toBe(1000);
      expect(maxRows).not.toHaveProperty("type");
      expect(at(maxRows, "anyOf", 0)).toEqual({ type: "number" });
    });

    test("keeps examples on the outer node and minimum in the typed branch of an integer leaf", () => {
      const patterned = at(cli, "properties", "compute", "anyOf", 0, "patternProperties");
      const entries = Object.values(patterned);
      expect(entries).toHaveLength(1);
      const instances = at(entries[0], "properties", "instances");
      expect(instances.description).toMatch(/Number of instances/);
      expect(instances.examples).toEqual([3]);
      expect(instances).not.toHaveProperty("minimum");
      expect(at(instances, "anyOf", 0)).toEqual({ type: "integer", minimum: 0 });
    });

    test("keeps hover docs on the outer node and the enum in the typed branch of a string enum", () => {
      const poolMode = at(
        cli,
        "properties",
        "db",
        "properties",
        "pooler",
        "properties",
        "pool_mode",
      );
      expect(poolMode.description).toMatch(/server connection can be reused/);
      expect(poolMode.default).toBe("transaction");
      expect(at(poolMode, "anyOf", 0)).toEqual({
        type: "string",
        enum: ["transaction", "session"],
      });
      expect(at(poolMode, "anyOf", 1)).toEqual({ type: "string", pattern: envPatternOf(cli) });
    });

    test("appends a single env branch to a union without wrapping its number member", () => {
      const fileSizeLimit = at(cli, "properties", "storage", "properties", "file_size_limit");
      expect(fileSizeLimit.anyOf).toHaveLength(3);
      expect(at(fileSizeLimit, "anyOf", 0)).toEqual({ type: "string" });
      expect(at(fileSizeLimit, "anyOf", 1)).toEqual({ type: "number" });
      expect(at(fileSizeLimit, "anyOf", 2)).toEqual({ type: "string", pattern: envPatternOf(cli) });
    });

    test("every number, integer, boolean and string-enum node sits next to exactly one env branch", () => {
      const { gaps, leaves } = findEnvReferenceGaps(cli);
      const typeKeywords =
        JSON.stringify(cli).match(/"type":"(?:number|integer|boolean|string","enum)"/g) ?? [];
      expect(leaves).toBeGreaterThan(0);
      expect(leaves).toBe(typeKeywords.length);
      expect(gaps).toEqual([]);
    });
  });

  describe("agreement with the loader's env() matching", () => {
    const samples = [
      "env(MAX_ROWS)",
      "env(max_rows)",
      "env(_X1)",
      "env(1ST)",
      "env()",
      "env(A B)",
      "env(A-B)",
      "env(日本語)",
      "env((X))",
      "env(env(X))",
      "env(X))",
      "ENV(X)",
      "Env(X)",
      "env(X",
      "env X)",
      " env(X)",
      "env(X) ",
      "prefix env(X)",
      "env(X)suffix",
      "env(A\nB)",
      "env(X)\n",
      "env",
      "$(X)",
      "${X}",
      "1000",
      "true",
      "",
    ];
    const validatePort = (value: unknown) => validateCli({ api: { port: value } });

    test("a numeric field accepts exactly the strings the loader treats as references", () => {
      expect(samples.filter((s) => validatePort(s) !== isEnvReference(s, true))).toEqual([]);
    });

    test("strict-mode references are a subset of what the schema accepts", () => {
      expect(samples.filter((s) => isEnvReference(s, false) && !validatePort(s))).toEqual([]);
    });

    test("every env branch in the document carries the same pattern", () => {
      const branches = collectEnvBranches(cli);
      expect(branches.length).toBeGreaterThan(0);
      expect(new Set(branches.map(patternOf))).toEqual(new Set([envPatternOf(cli)]));
    });

    test("a document using env() on numeric and boolean fields loads through the real loader", () => {
      const document = {
        api: { port: "env(API_PORT)", max_rows: "env(MAX_ROWS)" },
        auth: { enable_signup: "env(ENABLE_SIGNUP)" },
        db: {
          settings: { max_connections: "env(MAX_CONN)" },
          pooler: { pool_mode: "env(POOL_MODE)" },
        },
        compute: { web: { instances: "env(WEB_INSTANCES)" } },
      };
      expect(errorsFor(validateCli, document)).toEqual([]);

      const resolved = interpolateEnvReferencesAgainstSchema(
        document,
        {
          API_PORT: "54329",
          MAX_ROWS: "250",
          ENABLE_SIGNUP: "false",
          MAX_CONN: "80",
          WEB_INSTANCES: "3",
          POOL_MODE: "session",
        },
        CliConfigSchema,
        { goViperCompat: true },
      );
      const decoded = Schema.decodeUnknownSync(CliConfigSchema)(resolved);
      expect(decoded).toMatchObject({
        api: { port: 54329, max_rows: 250 },
        auth: { enable_signup: false },
        db: { settings: { max_connections: 80 }, pooler: { pool_mode: "session" } },
        compute: { web: { instances: 3 } },
      });
    });
  });
});

describe("toPublishedJsonSchemaDocument acceptEnvReferences", () => {
  const publish = (schema: Schema.Constraint, acceptEnvReferences?: boolean) =>
    toPublishedJsonSchemaDocument(schema, {
      onExcessProperty: "error",
      ...(acceptEnvReferences === undefined ? {} : { acceptEnvReferences }),
    });
  const envBranch = { type: "string", pattern: ENV_PATTERN };

  test("renders no env branch unless the option is on", () => {
    const schema = Schema.Struct({
      count: Schema.Finite,
      flag: Schema.Boolean,
      whole: Schema.Int,
      list: Schema.Array(Schema.Finite),
      maybe: Schema.Union([Schema.Finite, Schema.Null]),
    });
    const off = publish(schema);
    expect(publish(schema, false)).toEqual(off);
    expect(collectEnvBranches(off)).toEqual([]);
    expect(JSON.stringify(off)).not.toContain('"pattern"');
    expect(collectEnvBranches(publish(schema, true))).toHaveLength(5);
  });

  test("wraps properties named after JSON Schema keywords without losing a key", () => {
    const document = publish(
      Schema.Struct({ type: Schema.Finite, default: Schema.Boolean, enum: Schema.Int }),
      true,
    );
    expect(Object.keys(at(document, "properties"))).toEqual(["type", "default", "enum"]);
    expect(at(document, "required")).toEqual(["type", "default", "enum"]);
    expect(at(document, "properties", "type").anyOf).toEqual([{ type: "number" }, envBranch]);
    expect(at(document, "properties", "default").anyOf).toEqual([{ type: "boolean" }, envBranch]);
    expect(at(document, "properties", "enum").anyOf).toEqual([{ type: "integer" }, envBranch]);
  });

  test("hoists title, description, default and examples out of the typed branch", () => {
    const document = publish(
      Schema.Struct({
        count: Schema.Finite.annotate({
          title: "Count",
          description: "How many.",
          default: 3,
          examples: [4],
        }),
      }),
      true,
    );
    expect(at(document, "properties", "count")).toEqual({
      title: "Count",
      description: "How many.",
      default: 3,
      examples: [4],
      anyOf: [{ type: "number" }, envBranch],
    });
  });

  // The filter's toJsonSchema fragment is the one way to put object-valued const/enum into a document.
  test("leaves default, examples, const and enum data alone even when it looks like a schema", () => {
    const schema = Schema.Struct({
      annotated: Schema.Record(Schema.String, Schema.Unknown).annotate({
        default: { type: "number", nested: [{ type: "boolean" }] },
        examples: [{ type: "integer" }, { list: [{ type: "number" }] }],
      }),
      constrained: Schema.Record(Schema.String, Schema.Unknown).check(
        Schema.makeFilter(() => true, {
          toJsonSchema: () => ({
            const: { type: "number" },
            enum: [{ type: "boolean" }, { type: "number" }],
          }),
        }),
      ),
    });
    const off = publish(schema, false);
    const on = publish(schema, true);
    expect(at(on, "properties", "annotated").default).toEqual({
      type: "number",
      nested: [{ type: "boolean" }],
    });
    expect(at(on, "properties", "constrained", "allOf", 0).const).toEqual({ type: "number" });
    expect(on).toEqual(off);
    expect(JSON.stringify(on)).toBe(JSON.stringify(off));
  });

  test("wraps string enums but leaves plain and env() strings alone", () => {
    const document = publish(
      Schema.Struct({
        mode: Schema.Literals(["a", "b"]),
        name: Schema.String,
        token: env(),
      }),
      true,
    );
    expect(at(document, "properties", "mode").anyOf).toEqual([
      { type: "string", enum: ["a", "b"] },
      envBranch,
    ]);
    expect(at(document, "properties", "name")).toEqual({ type: "string" });
    expect(at(document, "properties", "token")).toEqual(envBranch);
  });

  test("appends one env branch to a union and leaves its members unwrapped", () => {
    const document = publish(
      Schema.Struct({
        nullable: Schema.Union([Schema.Finite, Schema.Null]),
        mixed: Schema.Union([Schema.Boolean, Schema.String]),
      }),
      true,
    );
    expect(at(document, "properties", "nullable").anyOf).toEqual([
      { type: "number" },
      { type: "null" },
      envBranch,
    ]);
    expect(at(document, "properties", "mixed").anyOf).toEqual([
      { type: "boolean" },
      { type: "string" },
      envBranch,
    ]);
  });

  test("does not add a second env branch to a union that already has one", () => {
    const document = publish(Schema.Struct({ count: Schema.Union([Schema.Finite, env()]) }), true);
    expect(at(document, "properties", "count").anyOf).toEqual([{ type: "number" }, envBranch]);
  });

  test("wraps numbers and booleans inside arrays and record values", () => {
    const document = publish(
      Schema.Struct({
        counts: Schema.Array(Schema.Finite),
        flags: Schema.Array(Schema.Boolean),
        limits: Schema.Record(Schema.String, Schema.Finite),
      }),
      true,
    );
    const validate = compile(document);
    expect(
      errorsFor(validate, {
        counts: [1, "env(COUNT)"],
        flags: [true, "env(FLAG)"],
        limits: { a: 1, b: "env(LIMIT)" },
      }),
    ).toEqual([]);
    expect(failingPaths(validate, { counts: ["1"], flags: [], limits: {} })).toContain("/counts/0");
    expect(failingPaths(validate, { counts: [], flags: ["true"], limits: {} })).toContain(
      "/flags/0",
    );
    expect(failingPaths(validate, { counts: [], flags: [], limits: { a: "env(X" } })).toContain(
      "/limits/a",
    );
  });

  test("wraps numbers and booleans in shared definitions", () => {
    const Port = Schema.Finite.annotate({ identifier: "Port" });
    const Flag = Schema.Boolean.annotate({ identifier: "Flag" });
    const document = publish(Schema.Struct({ a: Port, b: Port, c: Flag }), true);
    expect(at(document, "$defs", "Port").anyOf).toEqual([{ type: "number" }, envBranch]);
    expect(at(document, "$defs", "Flag").anyOf).toEqual([{ type: "boolean" }, envBranch]);
    const validate = compile(document);
    expect(errorsFor(validate, { a: "env(A)", b: 2, c: "env(C)" })).toEqual([]);
    expect(failingPaths(validate, { a: "x", b: 2, c: true })).toContain("/a");
  });

  test("the project config schema carries no env-reference branch", () => {
    const project = toProjectConfigJsonSchema();
    const maxRows = at(project, "properties", "api", "properties", "max_rows");
    expect(maxRows.type).toBe("number");
    expect(maxRows).not.toHaveProperty("anyOf");
    expect(findEnvReferenceGaps(project).leaves).toBeGreaterThan(0);
    expect(collectEnvBranches(project)).toEqual([]);
  });
});
