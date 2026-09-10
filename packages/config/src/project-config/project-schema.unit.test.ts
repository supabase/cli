import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema, SchemaAST } from "effect";
import * as SmolToml from "smol-toml";
import { CliConfigSchema } from "../base.ts";
import { isSecretPath, secretPathPatterns } from "../lib/secret-paths.ts";
import { getDefaultCliConfig } from "../sparse.ts";
import { HOSTED_SECTION_KEYS } from "./hosted-sections.ts";
import { fromApiProjectConfig, fromConfigDocument, toProjectConfig } from "./project-config.ts";
import type { ProjectConfig } from "./project-config.ts";
import { ProjectConfigSchema, toProjectConfigJsonSchema } from "./project-schema.ts";

const decodeCliConfig = Schema.decodeUnknownSync(CliConfigSchema);
const decodeProjectConfig = Schema.decodeUnknownSync(ProjectConfigSchema);

const legacyFixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../testdata/legacy-config.toml",
);

function apiEnvelope(attributes: Record<string, unknown>): unknown {
  return { data: { type: "project_config", id: "abcdefghijklmnopqrst", attributes } };
}

describe("ProjectConfigSchema acceptance", () => {
  test("an empty overlay validates", () => {
    expect(decodeProjectConfig({})).toEqual({});
  });

  test("a sparse, deeply nested overlay validates", () => {
    expect(decodeProjectConfig({ auth: { site_url: "https://example.com" } })).toEqual({
      auth: { site_url: "https://example.com" },
    });
  });

  test("a sparse overlay leaving required-looking siblings unset still validates", () => {
    // `db.pooler`'s sibling fields are all wrapped `optionalKey`, so naming only `enabled` must
    // not fail.
    expect(() => decodeProjectConfig({ db: { pooler: { enabled: true } } })).not.toThrow();
  });

  test("fromConfigDocument's output over the default CliConfig validates", () => {
    const projected = fromConfigDocument(getDefaultCliConfig());
    expect(() => decodeProjectConfig(projected)).not.toThrow();
  });

  test("fromConfigDocument's output over the real legacy-config.toml fixture validates", () => {
    const raw = SmolToml.parse(readFileSync(legacyFixturePath, "utf8"));
    const config = decodeCliConfig(raw);
    const projected = fromConfigDocument(config);
    expect(() => decodeProjectConfig(projected)).not.toThrow();
  });

  test("toProjectConfig's cliConfig arm validates", () => {
    const projected = toProjectConfig({ cliConfig: { api: { max_rows: 100 } } });
    expect(() => decodeProjectConfig(projected)).not.toThrow();
  });

  test("toProjectConfig's apiResponse arm validates, including the attached _apiResponse own property", () => {
    const projected = toProjectConfig({
      apiResponse: apiEnvelope({ database: { major_version: 17 } }),
    });
    expect(Object.getOwnPropertyNames(projected)).toContain("_apiResponse");
    expect(() => decodeProjectConfig(projected)).not.toThrow();
  });

  test("an API-sourced value built directly through fromApiProjectConfig validates", () => {
    const projected = fromApiProjectConfig(apiEnvelope({ database: { major_version: 17 } }));
    expect(() => decodeProjectConfig(projected)).not.toThrow();
  });

  test("db.vault of any shape validates but is dropped, since the schema no longer knows the key", () => {
    expect(decodeProjectConfig({ db: { vault: 42 } })).toEqual({ db: {} });
    expect(decodeProjectConfig({ db: { vault: {} } })).toEqual({ db: {} });
  });
});

describe("ProjectConfigSchema rejection", () => {
  test("auth.site_url as a number is rejected", () => {
    expect(() => decodeProjectConfig({ auth: { site_url: 123 } })).toThrow();
  });

  test("db.pooler.pool_mode with an unrecognized literal is rejected", () => {
    expect(() =>
      decodeProjectConfig({ db: { pooler: { pool_mode: "not-a-real-mode" } } }),
    ).toThrow();
  });

  test("db.pooler.pool_mode with a recognized literal is accepted", () => {
    expect(() =>
      decodeProjectConfig({ db: { pooler: { pool_mode: "transaction" } } }),
    ).not.toThrow();
  });
});

describe("ProjectConfigSchema secret-strip exhaustiveness", () => {
  // Exhaustive counterpart to a hand-picked field list: every `x-secret` path pattern rooted in a
  // hosted section must be structurally absent from `ProjectConfigSchema`'s own AST.
  const reachablePatterns = secretPathPatterns.filter((pattern) =>
    HOSTED_SECTION_KEYS.some((key) => key === (pattern[0] ?? "")),
  );

  test("guards the probe against a broken import silently emptying the pattern list", () => {
    expect(reachablePatterns.length).toBeGreaterThan(0);
    for (const pattern of reachablePatterns) {
      const concretePath = pattern.map((segment) => (segment === "*" ? "probe_key" : segment));
      expect(isSecretPath(concretePath)).toBe(true);
    }
  });

  /**
   * Walks {@link ProjectConfigSchema}'s AST along `pattern` (`"*"` descends into an index
   * signature, anything else into a same-named property signature); returns `undefined` once the
   * path can no longer be followed.
   */
  function findAtPattern(
    ast: SchemaAST.AST,
    pattern: ReadonlyArray<string>,
  ): SchemaAST.AST | undefined {
    let current: SchemaAST.AST | undefined = ast;
    for (const segment of pattern) {
      if (current === undefined || !SchemaAST.isObjects(current)) {
        return undefined;
      }
      current =
        segment === "*"
          ? current.indexSignatures[0]?.type
          : current.propertySignatures.find((property) => property.name === segment)?.type;
    }
    return current;
  }

  test("no x-secret path from the schema's own pattern list survives in ProjectConfigSchema's AST", () => {
    for (const pattern of reachablePatterns) {
      expect(findAtPattern(ProjectConfigSchema.ast, pattern)).toBeUndefined();
    }
  });

  // Guards against a vacuous pass: if an ancestor of `pattern` vanished entirely, the leaf lookup
  // also returns `undefined`, indistinguishable from a correctly-stripped secret. Asserting the
  // immediate parent is still reachable rules that out, except for a known all-secret collapsed
  // container (`db.vault`), whose own parent is dropped entirely — checked via its grandparent
  // instead.
  const KNOWN_ALL_SECRET_COLLAPSED_CONTAINER_PARENTS: ReadonlyArray<ReadonlyArray<string>> = [
    ["db", "vault"],
  ];

  test("the parent of every stripped x-secret path is still reachable, except a known all-secret collapsed container", () => {
    for (const pattern of reachablePatterns) {
      const parentPattern = pattern.slice(0, -1);
      const parent =
        parentPattern.length === 0
          ? ProjectConfigSchema.ast
          : findAtPattern(ProjectConfigSchema.ast, parentPattern);

      if (parent !== undefined) {
        continue;
      }

      const isKnownAllSecretContainer = KNOWN_ALL_SECRET_COLLAPSED_CONTAINER_PARENTS.some(
        (known) =>
          known.length === parentPattern.length &&
          known.every((segment, index) => segment === parentPattern[index]),
      );
      expect(
        isKnownAllSecretContainer,
        `parent of ${JSON.stringify(pattern)} vanished unexpectedly (not a known all-secret collapsed container)`,
      ).toBe(true);

      const grandparentPattern = parentPattern.slice(0, -1);
      const grandparent =
        grandparentPattern.length === 0
          ? ProjectConfigSchema.ast
          : findAtPattern(ProjectConfigSchema.ast, grandparentPattern);
      expect(grandparent, `grandparent of ${JSON.stringify(pattern)} vanished`).toBeDefined();

      const droppedName = parentPattern[parentPattern.length - 1];
      if (grandparent !== undefined && SchemaAST.isObjects(grandparent)) {
        expect(
          grandparent.propertySignatures.some((property) => property.name === droppedName),
        ).toBe(false);
      }
    }
  });

  /**
   * Recursively collects the dotted path of every reachable `Objects` node with zero properties
   * and zero index signatures — the shape a genuinely source-empty struct produces, and what an
   * all-secret collapsed container would also produce if it weren't dropped entirely instead.
   */
  function collectEmptyObjectPaths(
    ast: SchemaAST.AST,
    path: ReadonlyArray<string>,
    seen: Set<SchemaAST.AST>,
    into: string[],
  ): void {
    if (SchemaAST.isUnion(ast)) {
      if (seen.has(ast)) {
        return;
      }
      seen.add(ast);
      for (const member of ast.types) {
        collectEmptyObjectPaths(member, path, seen, into);
      }
      return;
    }
    if (!SchemaAST.isObjects(ast) || seen.has(ast)) {
      return;
    }
    seen.add(ast);
    if (ast.propertySignatures.length === 0 && ast.indexSignatures.length === 0) {
      into.push(path.join("."));
      return;
    }
    for (const property of ast.propertySignatures) {
      collectEmptyObjectPaths(property.type, [...path, String(property.name)], seen, into);
    }
    for (const indexSignature of ast.indexSignatures) {
      collectEmptyObjectPaths(indexSignature.type, [...path, "*"], seen, into);
    }
  }

  test("no all-secret container besides db.vault collapses to an empty, accept-anything node", () => {
    const emptyObjectPaths: string[] = [];
    collectEmptyObjectPaths(ProjectConfigSchema.ast, [], new Set(), emptyObjectPaths);

    expect(emptyObjectPaths.toSorted()).toEqual(
      ["storage.analytics.buckets.*", "storage.vector.buckets.*"].toSorted(),
    );
  });
});

describe("ProjectConfigSchema hosted-section keys", () => {
  // Asserts against the schema's own public AST rather than the module's private struct, so a
  // schema-module import can't crash a consumer for a condition this test already covers.
  test("the schema's own top-level property names are exactly HOSTED_SECTION_KEYS", () => {
    if (!SchemaAST.isObjects(ProjectConfigSchema.ast)) {
      throw new Error("expected ProjectConfigSchema.ast to be an Objects node");
    }
    const actualKeys = ProjectConfigSchema.ast.propertySignatures.map((property) =>
      String(property.name),
    );
    expect(actualKeys.toSorted()).toEqual([...HOSTED_SECTION_KEYS].toSorted());
  });
});

describe("ProjectConfigSchema derivation AST-walk exhaustiveness", () => {
  // `toDeepOptionalHostedAst` (project-schema.ts) enumerates AST node kinds explicitly and leaves
  // `Suspend` unhandled; this walks the actual derived AST and fails loudly if a node kind outside
  // that set appears, instead of silently falling through to the leaf case.
  const HANDLED_CONTAINER_TAGS = new Set(["Objects", "Arrays", "Union"]);
  const HANDLED_LEAF_TAGS = new Set(["String", "Number", "Boolean", "Literal"]);

  function walk(ast: SchemaAST.AST, seen: Set<SchemaAST.AST>): void {
    if (seen.has(ast)) {
      return;
    }
    seen.add(ast);

    if (HANDLED_CONTAINER_TAGS.has(ast._tag) || HANDLED_LEAF_TAGS.has(ast._tag)) {
      if (SchemaAST.isObjects(ast)) {
        for (const property of ast.propertySignatures) {
          walk(property.type, seen);
        }
        for (const indexSignature of ast.indexSignatures) {
          walk(indexSignature.type, seen);
        }
      } else if (SchemaAST.isArrays(ast)) {
        for (const element of ast.elements) {
          walk(element, seen);
        }
        for (const rest of ast.rest) {
          walk(rest, seen);
        }
      } else if (SchemaAST.isUnion(ast)) {
        for (const member of ast.types) {
          walk(member, seen);
        }
      }
      return;
    }

    throw new Error(
      `ProjectConfigSchema's derived AST contains a node kind ("${ast._tag}") that ` +
        "toDeepOptionalHostedAst (project-schema.ts) isn't written to understand yet — " +
        "the derivation must learn this new node kind (secret-stripping, optionality, and " +
        "checks-stripping all need a deliberate decision for it) before this guard can pass.",
    );
  }

  test("every node kind reachable from ProjectConfigSchema.ast is in the handled set", () => {
    walk(ProjectConfigSchema.ast, new Set());
  });
});

describe("ProjectConfigSchema local-only sections", () => {
  test("a full CliConfig's local-only sections are silently ignored, not validated or echoed back", () => {
    const result = decodeProjectConfig(getDefaultCliConfig());
    for (const localOnlyKey of [
      "project_id",
      "studio",
      "edge_runtime",
      "analytics",
      "functions",
      "local_smtp",
      "remotes",
    ]) {
      expect(Object.hasOwn(result, localOnlyKey)).toBe(false);
    }
  });
});

describe("ProjectConfigSchema Standard Schema interop", () => {
  test("~standard reports the effect vendor", () => {
    expect(ProjectConfigSchema["~standard"].vendor).toBe("effect");
    expect(ProjectConfigSchema["~standard"].version).toBe(1);
  });

  test("~standard.validate returns a value on success", async () => {
    const outcome = ProjectConfigSchema["~standard"].validate({
      auth: { site_url: "https://example.com" },
    });
    const result = outcome instanceof Promise ? await outcome : outcome;
    expect(result.issues).toBeUndefined();
    if (!result.issues) {
      expect(result.value).toEqual({ auth: { site_url: "https://example.com" } });
    }
  });

  test("~standard.validate returns issues with paths on failure", async () => {
    const outcome = ProjectConfigSchema["~standard"].validate({ auth: { site_url: 123 } });
    const result = outcome instanceof Promise ? await outcome : outcome;
    expect(result.issues).toBeDefined();
    expect(result.issues?.[0]?.path).toBeDefined();
  });
});

describe("toProjectConfigJsonSchema", () => {
  const typedDocument = toProjectConfigJsonSchema();
  // `JsonSchema.JsonSchema` has no named properties, so TypeScript can't statically type the
  // nested fields; round-tripping through JSON gives a plainly-navigable value without an `as`
  // cast.
  const document = JSON.parse(JSON.stringify(typedDocument));

  test("declares the draft 2020-12 dialect", () => {
    expect(typedDocument.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
  });

  test("top-level properties are exactly the seven hosted sections", () => {
    expect(Object.keys(document.properties).sort()).toEqual([...HOSTED_SECTION_KEYS].toSorted());
  });

  test("no required array forces presence anywhere spot-checked", () => {
    expect(document.required).toBeUndefined();
    expect(document.properties.auth.required).toBeUndefined();
    expect(document.properties.db.properties.pooler.required).toBeUndefined();
  });

  test("db.vault disappears from the schema entirely (an all-secret container is dropped, not emptied)", () => {
    expect(Object.hasOwn(document.properties.db.properties, "vault")).toBe(false);
  });

  test("is JSON-serializable and stable across two calls", () => {
    expect(() => JSON.stringify(typedDocument)).not.toThrow();
    expect(JSON.parse(JSON.stringify(toProjectConfigJsonSchema()))).toEqual(document);
  });
});

describe("ProjectConfigSchema type-level pin", () => {
  // Compile-time drift guard: re-derives the expected shape from `ProjectConfig` itself, so a
  // future edit to either side that silently drifts fails to compile here. Both directions hold
  // because the only structural difference is optional-property presence (`_apiResponse` vs.
  // `x-secret` leaves), and TypeScript's structural assignability doesn't require a source to have
  // or lack an optional property the target lacks or has.
  type ExpectedProjectConfigSchemaType = Omit<ProjectConfig, "_apiResponse">;
  type DerivedProjectConfigSchemaType = typeof ProjectConfigSchema.Type;

  const _derivedAssignableToExpected: (
    value: DerivedProjectConfigSchemaType,
  ) => ExpectedProjectConfigSchemaType = (value) => value;

  const _expectedAssignableToDerived: (
    value: ExpectedProjectConfigSchemaType,
  ) => DerivedProjectConfigSchemaType = (value) => value;

  test("both assignability directions compile", () => {
    expect(typeof _derivedAssignableToExpected).toBe("function");
    expect(typeof _expectedAssignableToDerived).toBe("function");
  });
});
