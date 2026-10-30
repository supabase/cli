import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import { Result, Schema, SchemaIssue } from "effect";
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
const SCHEMA_MAP_KEYWORDS = new Set(["properties", "patternProperties", "definitions"]);

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

const collectEnvBranches = (document: unknown): Array<Node> => {
  const found: Array<Node> = [];
  visitSchemas(document, (node, _path, siblings) => {
    if (siblings !== undefined && isEnvBranch(node)) found.push(node);
  });
  return found;
};

const patternOf = (node: Node): string => {
  if (typeof node.pattern !== "string") throw new Error("expected the node to carry a pattern");
  return node.pattern;
};

const compile = (document: Node): ValidateFunction => new Ajv({ strict: false }).compile(document);

const errorsFor = (validate: ValidateFunction, value: unknown): ReadonlyArray<ErrorObject> =>
  validate(value) ? [] : [...(validate.errors ?? [])];

const failingPaths = (validate: ValidateFunction, value: unknown): ReadonlyArray<string> => [
  ...new Set(errorsFor(validate, value).map((error) => error.instancePath)),
];

const envPatternOf = (document: Node): string =>
  patternOf(at(document, "properties", "api", "properties", "max_rows", "anyOf", 1));

const RECORD_KEYS = ["sample", "SAMPLE"];

const collectLeaves = (node: unknown, path: Path = []): Array<readonly [Path, Node]> => {
  if (!isNode(node)) return [];
  const { properties, patternProperties, additionalProperties, anyOf, items } = node;
  if (isNode(properties) || isNode(patternProperties) || isNode(additionalProperties)) {
    return [
      ...Object.entries(isNode(properties) ? properties : {}).flatMap(([name, child]) =>
        collectLeaves(child, [...path, name]),
      ),
      ...Object.entries(isNode(patternProperties) ? patternProperties : {}).flatMap(
        ([pattern, child]) => {
          const key = RECORD_KEYS.find((candidate) => new RegExp(pattern, "u").test(candidate));
          return key === undefined ? [] : collectLeaves(child, [...path, key]);
        },
      ),
      ...collectLeaves(additionalProperties, [...path, "sample"]),
    ];
  }
  if (Array.isArray(anyOf) && anyOf.some((member) => isNode(member) && member.type === "object")) {
    return anyOf.flatMap((member) => collectLeaves(member, path));
  }
  if (isNode(items) && items.type === "object") return collectLeaves(items, [...path, 0]);
  return [[path, node]];
};

const envValueFor = (leaf: Node): string | undefined => {
  const typed = Array.isArray(leaf.anyOf) ? at(leaf, "anyOf", 0) : leaf;
  switch (typed.type) {
    case "boolean":
      return "false";
    case "number":
    case "integer":
      return "1";
    case "array":
      return "a,b";
    case "string":
      return Array.isArray(typed.enum) ? String(typed.enum.find((value) => value !== "")) : "x";
    default:
      return undefined;
  }
};

const documentAt = (path: Path, value: unknown): unknown =>
  path.reduceRight<unknown>(
    (child, key) => (typeof key === "number" ? [child] : { [key]: child }),
    value,
  );

const isAtOrBelow = (issuePath: ReadonlyArray<unknown>, path: Path): boolean =>
  path.every((key, index) => String(issuePath[index]) === String(key));

const schemaAcceptsAt = (validate: ValidateFunction, path: Path, value: unknown): boolean =>
  !failingPaths(validate, documentAt(path, value)).some((pointer) =>
    isAtOrBelow(pointer.split("/").slice(1), path),
  );

// Checks are off so only type acceptance is compared, not value rules such as port ranges.
const decodeCli = Schema.decodeUnknownResult(CliConfigSchema, {
  errors: "all",
  disableChecks: true,
});
const toIssues = SchemaIssue.makeFormatterStandardSchemaV1();

const loaderAcceptsAt = (
  path: Path,
  value: unknown,
  env: Readonly<Record<string, string>>,
): boolean => {
  const resolved = interpolateEnvReferencesAgainstSchema(
    documentAt(path, value),
    env,
    CliConfigSchema,
    {
      cliCompat: true,
    },
  );
  const result = decodeCli(resolved);
  if (Result.isSuccess(result)) return true;
  return !toIssues(result.failure.issue).issues.some((issue) =>
    isAtOrBelow(
      (issue.path ?? []).map((segment) => (typeof segment === "object" ? segment.key : segment)),
      path,
    ),
  );
};

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

  test("migration checks publish a closed object with patterned exclusions", () => {
    const checks = at(
      toCliConfigJsonSchema(),
      "properties",
      "db",
      "properties",
      "migrations",
      "properties",
      "checks",
    );
    const rules = [
      "rls_disabled_in_public",
      "rls_enabled_no_policy",
      "policy_exists_rls_disabled",
      "security_definer_view",
      "rls_policy_always_true",
      "sensitive_columns_exposed",
      "auth_users_exposed",
      "function_search_path_mutable",
      "rls_references_user_metadata",
    ];
    expect(checks).not.toHaveProperty("allOf");
    expect(checks).toHaveProperty("additionalProperties", false);
    expect(Object.keys(at(checks, "properties")).sort()).toEqual([...rules, "exclude"].sort());
    const exclude = at(checks, "properties", "exclude");
    expect(Object.keys(at(exclude, "properties")).sort()).toEqual([...rules].sort());
    for (const rule of rules) {
      expect(at(checks, "properties", rule)).toMatchObject({
        anyOf: expect.arrayContaining([{ type: "string", enum: ["error", "warn", "off"] }]),
      });
      const list = at(exclude, "properties", rule, "anyOf", 0);
      expect(list).toMatchObject({ type: "array" });
      expect(at(list, "items").pattern).toEqual(expect.any(String));
    }
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

  test.each(["email", "sms"])(
    "describes project config auth.%s.enable_signup like the CLI enabled alias, not as deprecated",
    (section) => {
      const cli = at(toCliConfigJsonSchema(), "properties", "auth", "properties", section);
      const project = at(toProjectConfigJsonSchema(), "properties", "auth", "properties", section);

      const enabledDescription = at(cli, "properties", "enabled").description;
      expect(enabledDescription).toBeTypeOf("string");
      expect(enabledDescription).not.toContain("Deprecated");
      expect(at(project, "properties", "enable_signup").description).toBe(enabledDescription);
      expect(at(cli, "properties", "enable_signup").description).toContain("Deprecated");
    },
  );

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
    auth: { enable_signup: true, email: { enabled: false }, sms: { enabled: true } },
    db: { settings: { max_connections: 100 } },
    compute: { web: { instances: 2 } },
    storage: { file_size_limit: "50MiB" },
    remotes: {
      staging: {
        api: { max_rows: 500 },
        auth: { email: { enabled: true } },
        compute: { web: { instances: 4 } },
      },
    },
  };

  describe("validation", () => {
    test("a document of plain literals validates", () => {
      expect(errorsFor(validateCli, baseline)).toEqual([]);
    });

    test.each([
      ["api.max_rows", { api: { max_rows: "env(MAX_ROWS)" } }],
      ["api.port", { api: { port: "env(API_PORT)" } }],
      ["auth.enable_signup", { auth: { enable_signup: "env(ENABLE_SIGNUP)" } }],
      ["auth.email.enabled", { auth: { email: { enabled: "env(EMAIL_ENABLED)" } } }],
      ["auth.sms.enabled", { auth: { sms: { enabled: "env(SMS_ENABLED)" } } }],
      ["db.settings.max_connections", { db: { settings: { max_connections: "env(MAX_CONN)" } } }],
      ["compute.<name>.instances", { compute: { web: { instances: "env(WEB_INSTANCES)" } } }],
      ["storage.file_size_limit", { storage: { file_size_limit: "env(FILE_SIZE_LIMIT)" } }],
      ["db.pooler.pool_mode", { db: { pooler: { pool_mode: "env(POOL_MODE)" } } }],
      ["realtime.ip_version", { realtime: { ip_version: "env(IP_VERSION)" } }],
      [
        "auth.additional_redirect_urls",
        { auth: { additional_redirect_urls: "env(REDIRECT_URLS)" } },
      ],
      ["remotes.<name>.api.max_rows", { remotes: { staging: { api: { max_rows: "env(ROWS)" } } } }],
      [
        "remotes.<name>.auth.enable_signup",
        { remotes: { staging: { auth: { enable_signup: "env(SIGNUP)" } } } },
      ],
      [
        "remotes.<name>.auth.email.enabled",
        { remotes: { staging: { auth: { email: { enabled: "env(EMAIL)" } } } } },
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
      [
        "a word in a provider enabled field",
        { auth: { sms: { enabled: "yes" } } },
        "/auth/sms/enabled",
      ],
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

    test("every field accepts env() in the schema exactly when the loader resolves it", () => {
      const port = ["api", "port"];
      expect(loaderAcceptsAt(port, "env(SAMPLE)", {})).toBe(false);
      expect(loaderAcceptsAt(port, "env(SAMPLE)", { SAMPLE: "1" })).toBe(true);

      const leaves = collectLeaves(cli).flatMap(([path, leaf]) => {
        const value = envValueFor(leaf);
        return value === undefined ? [] : [{ path, value }];
      });
      const mismatches: Array<string> = [];
      for (const { path, value } of leaves) {
        const schema = schemaAcceptsAt(validateCli, path, "env(SAMPLE)");
        const loader = loaderAcceptsAt(path, "env(SAMPLE)", { SAMPLE: value });
        if (schema !== loader)
          mismatches.push(`${path.join(".")}: schema ${schema}, loader ${loader}`);
      }
      expect(leaves.length).toBeGreaterThan(500);
      expect(mismatches).toEqual([]);
    }, 60_000);
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
    const document = publish(
      Schema.Struct({
        count: Schema.Union([Schema.Finite, env()]),
        token: Schema.Union([Schema.Finite, env({ description: "Token", secret: true })]),
      }),
      true,
    );
    expect(at(document, "properties", "count").anyOf).toEqual([{ type: "number" }, envBranch]);
    const token = at(document, "properties", "token").anyOf as Array<Node>;
    expect(token).toHaveLength(2);
    expect(token[0]).toEqual({ type: "number" });
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

  test("accepts env() in place of a whole string list but not a list of enums", () => {
    const document = publish(
      Schema.Struct({
        names: Schema.Array(Schema.String),
        modes: Schema.Array(Schema.Literals(["a", "b"])),
      }),
      true,
    );
    const validate = compile(document);
    expect(errorsFor(validate, { names: "env(NAMES)", modes: ["a", "env(MODE)"] })).toEqual([]);
    expect(failingPaths(validate, { names: [], modes: "env(MODES)" })).toContain("/modes");
  });

  test("wraps numbers and booleans in shared definitions", () => {
    const Port = Schema.Finite.annotate({ identifier: "Port" });
    const Flag = Schema.Boolean.annotate({ identifier: "Flag" });
    const document = publish(Schema.Struct({ a: Port, b: Port, c: Flag }), true);
    expect(at(document, "definitions", "Port").anyOf).toEqual([{ type: "number" }, envBranch]);
    expect(at(document, "definitions", "Flag").anyOf).toEqual([{ type: "boolean" }, envBranch]);
    const validate = compile(document);
    expect(errorsFor(validate, { a: "env(A)", b: 2, c: "env(C)" })).toEqual([]);
    expect(failingPaths(validate, { a: "x", b: 2, c: true })).toContain("/a");
  });

  test("renders shared definitions under draft-07 `definitions` with matching refs", () => {
    const Port = Schema.Finite.annotate({ identifier: "Port" });
    const document = publish(Schema.Struct({ a: Port, b: Port }), true);
    expect(document.$schema).toBe("http://json-schema.org/draft-07/schema#");
    expect(document).not.toHaveProperty("$defs");
    expect(Object.keys(at(document, "definitions"))).toEqual(["Port"]);
    expect(at(document, "properties", "a")).toEqual({ $ref: "#/definitions/Port" });
    expect(JSON.stringify(document)).not.toContain("#/$defs/");
  });

  test("the project config schema carries no env-reference branch", () => {
    const project = toProjectConfigJsonSchema();
    const maxRows = at(project, "properties", "api", "properties", "max_rows");
    expect(maxRows.type).toBe("number");
    expect(maxRows).not.toHaveProperty("anyOf");
    expect(collectEnvBranches(project)).toEqual([]);
  });
});
