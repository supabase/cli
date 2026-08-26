import { describe, expect, test } from "vitest";
import { CliConfigSchema } from "../base.ts";
import { ProjectConfigApiAttributesSchema } from "./api-attributes.ts";
import { unmappedSecretApiPaths } from "./registry-auth.ts";
import { projectConfigMappingRows } from "./registry.ts";

/**
 * Standing AST-walk drift guard (CLI-2230): every row's `configPath` must
 * resolve against {@link CliConfigSchema}'s AST, and every row's `apiPath`
 * (plus `alsoConsumes` and `./registry-auth.ts`'s `unmappedSecretApiPaths`)
 * must resolve against {@link ProjectConfigApiAttributesSchema}'s AST. This
 * is what keeps the 233 rows across `./registry.ts`/`./registry-auth.ts`
 * true when either schema moves — a renamed or removed field fails a test
 * here instead of silently producing a `ProjectConfig` that never populates
 * (a wrong `configPath`) or a row that never reads a real API field (a
 * wrong `apiPath`).
 *
 * The walker below mirrors `../lib/env.ts`'s `descendAst`/`../lib/
 * secret-paths.ts`'s `collectSecretPathPatterns`: Effect v4 represents both
 * `Schema.Struct` and `Schema.Record` as an `"Objects"` AST node
 * (`.repos/effect/packages/effect/src/SchemaAST.ts:2038-2090`), carrying
 * named `propertySignatures` (struct fields) and/or `indexSignatures`
 * (record key patterns) side by side on the same node type. Descending a
 * path segment therefore tries an exact-name property signature first, then
 * falls back to the first index signature's value type — the record
 * fallback is what "the auth record accepts any second segment" means for
 * `ProjectConfigApiAttributesSchema`'s `auth: Schema.Record(Schema.String,
 * Schema.Json)` field: every row's two-segment `["auth", "<gotrue_key>"]`
 * `apiPath` resolves through that index signature, not a named property.
 */

interface AstNode {
  readonly _tag?: string;
  readonly propertySignatures?: ReadonlyArray<{
    readonly name: PropertyKey;
    readonly type: unknown;
  }>;
  readonly indexSignatures?: ReadonlyArray<{ readonly type: unknown }>;
  readonly types?: ReadonlyArray<unknown>;
  readonly thunk?: () => unknown;
}

/** Unwraps a `Suspend` (lazy AST reference from a recursive schema) down to its concrete node. */
function unwrapSuspend(node: unknown): AstNode | undefined {
  let current = node as AstNode | undefined;
  while (
    current !== undefined &&
    current._tag === "Suspend" &&
    typeof current.thunk === "function"
  ) {
    current = current.thunk() as AstNode;
  }
  return current;
}

/** Descends one path `segment` from `node`, trying every `Union` branch in order, then property signatures, then the first index signature. */
function descendOneSegment(node: unknown, segment: string): unknown {
  const ast = unwrapSuspend(node);
  if (ast === undefined) {
    return undefined;
  }
  if (ast._tag === "Union" && ast.types !== undefined) {
    for (const variant of ast.types) {
      const next = descendOneSegment(variant, segment);
      if (next !== undefined) {
        return next;
      }
    }
    return undefined;
  }
  const property = ast.propertySignatures?.find((candidate) => candidate.name === segment);
  if (property !== undefined) {
    return property.type;
  }
  if (ast.indexSignatures !== undefined && ast.indexSignatures.length > 0) {
    return ast.indexSignatures[0]?.type;
  }
  return undefined;
}

/** Whether every segment of `path` resolves, in order, starting from `rootAst`. */
function pathResolves(rootAst: unknown, path: ReadonlyArray<string>): boolean {
  let current: unknown = rootAst;
  for (const segment of path) {
    current = descendOneSegment(current, segment);
    if (current === undefined) {
      return false;
    }
  }
  return true;
}

describe("registry integrity: every row resolves against both schemas", () => {
  test("the registry actually has rows to check", () => {
    // Guards against the loop below passing vacuously if the registry import
    // is ever broken.
    expect(projectConfigMappingRows.length).toBeGreaterThan(100);
  });

  for (const row of projectConfigMappingRows) {
    const configPathLabel = row.configPath.join(".");
    const apiPathLabel = row.apiPath.join(".");

    test(`configPath "${configPathLabel}" resolves against CliConfigSchema`, () => {
      expect(pathResolves(CliConfigSchema.ast, row.configPath)).toBe(true);
    });

    test(`apiPath "${apiPathLabel}" (for configPath "${configPathLabel}") resolves against ProjectConfigApiAttributesSchema`, () => {
      expect(pathResolves(ProjectConfigApiAttributesSchema.ast, row.apiPath)).toBe(true);
    });

    for (const alsoPath of row.alsoConsumes ?? []) {
      test(`alsoConsumes path "${alsoPath.join(".")}" (for configPath "${configPathLabel}") resolves against ProjectConfigApiAttributesSchema`, () => {
        expect(pathResolves(ProjectConfigApiAttributesSchema.ast, alsoPath)).toBe(true);
      });
    }
  }

  for (const secretPath of unmappedSecretApiPaths) {
    test(`unmappedSecretApiPaths entry "${secretPath.join(".")}" resolves against ProjectConfigApiAttributesSchema`, () => {
      expect(pathResolves(ProjectConfigApiAttributesSchema.ast, secretPath)).toBe(true);
    });
  }
});
