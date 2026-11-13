import { Schema, SchemaAST } from "effect";
import { CliConfigSchema, type CliConfig } from "./base.ts";
import { interpolateEnvReferencesAgainstSchema, standInAtPath } from "./lib/env.ts";
import {
  type CliConfigDecodeIssue,
  flattenCliConfigDecodeIssues,
} from "./cli-config-decode-issues.ts";

function withoutTableRules(ast: SchemaAST.AST): SchemaAST.AST {
  if (SchemaAST.isObjects(ast)) {
    return new SchemaAST.Objects(
      ast.propertySignatures.map(
        (property) =>
          new SchemaAST.PropertySignature(property.name, withoutTableRules(property.type)),
      ),
      ast.indexSignatures.map(
        (indexSignature) =>
          new SchemaAST.IndexSignature(
            indexSignature.parameter,
            withoutTableRules(indexSignature.type),
          ),
      ),
      ast.annotations,
      undefined,
      withoutTableRulesEncoding(ast.encoding),
      ast.context,
      undefined,
    );
  }
  if (SchemaAST.isArrays(ast)) {
    return new SchemaAST.Arrays(
      ast.isMutable,
      ast.elements.map(withoutTableRules),
      ast.rest.map(withoutTableRules),
      ast.annotations,
      ast.checks,
      withoutTableRulesEncoding(ast.encoding),
      ast.context,
      ast.encodingChecks,
    );
  }
  if (SchemaAST.isUnion(ast)) {
    return new SchemaAST.Union(
      ast.types.map(withoutTableRules),
      ast.options,
      ast.annotations,
      ast.checks,
      withoutTableRulesEncoding(ast.encoding),
      ast.context,
      ast.encodingChecks,
    );
  }
  return ast;
}

function withoutTableRulesEncoding(
  encoding: SchemaAST.Encoding | undefined,
): SchemaAST.Encoding | undefined {
  if (encoding === undefined) {
    return undefined;
  }
  const [head, ...tail] = encoding;
  const strip = (link: SchemaAST.Link) =>
    new SchemaAST.Link(withoutTableRules(link.to), link.transformation);
  return [strip(head), ...tail.map(strip)];
}

/**
 * {@link CliConfigSchema} with every table-level `.check()` removed and every leaf check (name
 * patterns, numeric bounds, `env()` patterns) kept.
 */
const CliConfigSchemaWithoutTableRules = Schema.make<Schema.Codec<CliConfig>>(
  withoutTableRules(CliConfigSchema.ast),
);

const decodeWithoutTableRules = Schema.decodeUnknownResult(CliConfigSchemaWithoutTableRules, {
  errors: "all",
});

export type CliConfigWithoutTableRulesResult =
  | { readonly _tag: "Success"; readonly value: CliConfig }
  | { readonly _tag: "Failure"; readonly issues: ReadonlyArray<CliConfigDecodeIssue> };

/**
 * Decodes a CLI config document with leaf rules only, collecting every issue; `cliCompat` splits
 * literal comma strings at array paths as `start` does.
 */
export function decodeCliConfigWithoutTableRules(
  document: unknown,
  options?: { readonly cliCompat?: boolean },
): CliConfigWithoutTableRulesResult {
  const result = decodeWithoutTableRules(
    options?.cliCompat === true
      ? interpolateEnvReferencesAgainstSchema(document, {}, CliConfigSchema, { cliCompat: true })
      : document,
  );
  if (result._tag === "Success") {
    return { _tag: "Success", value: result.success };
  }
  return { _tag: "Failure", issues: flattenCliConfigDecodeIssues(result.failure.issue) };
}

/** Lists every `env(NAME)` leaf outside deferred fields; array elements report at the outermost array key. */
export function collectCliConfigEnvReferences(
  document: unknown,
): ReadonlyArray<{ readonly path: ReadonlyArray<string>; readonly name: string }> {
  const found: Array<{ path: ReadonlyArray<string>; name: string }> = [];
  interpolateEnvReferencesAgainstSchema(document, {}, CliConfigSchema, {
    cliCompat: true,
    onEnvReference: (path, name) => found.push({ path, name }),
  });
  return found;
}

/** A type-correct placeholder for the `CliConfigSchema` leaf at `path`, or `undefined` if it does not resolve. */
export function cliConfigStandIn(path: ReadonlyArray<string>): unknown {
  return standInAtPath(CliConfigSchema, path);
}
