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
    // `db.pooler`'s own fields (`pool_mode`, `default_pool_size`, …) are all
    // present in `CliConfigSchema`, but this schema wraps every one of them
    // `optionalKey` — a fragment naming only `enabled` must not fail just
    // because it says nothing about the rest of the section.
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
  // Schema-derived, exhaustive counterpart to a hand-picked field list
  // (matching `project-config.unit.test.ts`'s own exhaustive-probe
  // precedent): every `x-secret` path pattern the schema declares, rooted in
  // one of the seven hosted sections, must be structurally absent from
  // `ProjectConfigSchema`'s own AST — not merely absent from one hand-picked
  // example.
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
   * Walks {@link ProjectConfigSchema}'s own AST along `pattern`, treating a
   * `"*"` segment as "descend into the node's own index signature" and every
   * other segment as "descend into the property signature of that name" —
   * returns `undefined` the moment the path can no longer be followed, which
   * is exactly the outcome a dropped secret property/index-signature
   * produces.
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

  // Guards against a vacuous pass: if an ANCESTOR of `pattern` vanished
  // (e.g. a whole section got dropped by an unrelated bug), `findAtPattern`
  // for the full secret path also returns `undefined` — indistinguishable,
  // from that assertion alone, from the secret leaf being correctly
  // stripped. Asserting the parent path is still reachable rules that out.
  test("the parent of every stripped x-secret path is still reachable", () => {
    for (const pattern of reachablePatterns) {
      const parentPattern = pattern.slice(0, -1);
      const parent =
        parentPattern.length === 0
          ? ProjectConfigSchema.ast
          : findAtPattern(ProjectConfigSchema.ast, parentPattern);
      expect(parent, `parent of ${JSON.stringify(pattern)} vanished`).toBeDefined();
    }
  });
});

describe("ProjectConfigSchema hosted-section keys", () => {
  // Moved from an import-time throw in `project-schema.ts` (CLI-2234): a
  // schema-module import should never be able to crash a consumer's
  // process for a condition a test already covers. Asserts against the
  // PUBLIC, observable `ProjectConfigSchema.ast` rather than reaching into
  // the module's private `hostedSectionsStruct`.
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
  // CLI-2234 group 7c/7d: `toDeepOptionalHostedAst` (`project-schema.ts`)
  // enumerates AST node kinds explicitly rather than through a generic
  // recursion helper (see that module's doc comment for why) and
  // deliberately leaves `Suspend` unhandled. This walks the ACTUAL derived
  // `ProjectConfigSchema.ast` and fails loudly the moment a node kind
  // outside the set that derivation is written to understand appears,
  // rather than letting a future schema addition silently fall through
  // `toDeepOptionalHostedAst`'s final `return ast` (correct for a true
  // leaf, silently wrong for an unhandled container/recursive kind).
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
  // `JsonSchema.JsonSchema` (`effect`) is an open `[x: string]: unknown`
  // record with no named properties, so TypeScript can't statically type
  // `typedDocument`'s nested `properties`/`required`/… fields — the same
  // reason `io.unit.test.ts`'s own `toCliConfigJsonSchema` coverage asserts
  // through a stringified rendering rather than typed property access. A
  // JSON round trip gives every assertion below a plainly-navigable value
  // without an `as` cast.
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

  test("the db.vault secret record collapses to a schema with no properties left to leak", () => {
    const vault = document.properties.db.properties.vault;
    expect(vault.properties).toBeUndefined();
    expect(vault.patternProperties).toBeUndefined();
  });

  test("is JSON-serializable and stable across two calls", () => {
    expect(() => JSON.stringify(typedDocument)).not.toThrow();
    expect(JSON.parse(JSON.stringify(toProjectConfigJsonSchema()))).toEqual(document);
  });
});

describe("ProjectConfigSchema type-level pin", () => {
  // Compile-time drift guard (CLI-2234 design requirement, mirroring
  // `apps/cli/src/shared/config/project-config-api-drift.unit.test.ts`'s
  // `_typeDriftGuard`/`AssertNever` style): `ProjectConfigSchema`'s own
  // generic annotation (`project-schema.ts`) and `ProjectConfig`
  // (`project-config.ts`) are independent expressions of the same shape —
  // this file re-derives the expected shape from `ProjectConfig` itself
  // (rather than importing `project-schema.ts`'s private type alias) so a
  // future edit to either side that silently drifts fails to compile here.
  //
  // Both directions hold because the only structural difference between the
  // two sides is optional-property PRESENCE: `ProjectConfigSchema`'s Type
  // never carries an `_apiResponse` key at all (never modeled, ADR 0019), and
  // `ProjectConfig` types every `x-secret` leaf as present-but-optional even
  // though the runtime derivation drops those keys entirely from the schema.
  // TypeScript's structural assignability does not require a source type to
  // have (or lack) an optional property the target also lacks (or has), so a
  // missing or extra OPTIONAL property never blocks assignability in either
  // direction — verified by actually compiling both functions below, not
  // merely asserted in prose.
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
