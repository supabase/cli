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
