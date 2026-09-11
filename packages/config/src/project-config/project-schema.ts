/**
 * Runtime schema for {@link ProjectConfig}, derived from {@link CliConfigSchema} so the two shapes
 * cannot drift independently: picks the seven hosted-section fields, strips down to the decoded
 * shape, then makes every property deep-optional while dropping secret-only (`x-secret`) leaves
 * and containers and struct-level `.check()` refinements a sparse overlay can't satisfy. Always
 * permissive (`additionalProperties: true`); `_apiResponse` is non-enumerable, so it's excluded.
 */
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { Schema, SchemaAST } from "effect";
import { CliConfigSchema } from "../base.ts";
import type { ProjectConfig } from "./project-config.ts";

function isSecretAst(ast: SchemaAST.AST): boolean {
  return ast.annotations?.["x-secret"] === true;
}

function hasObjectMembers(ast: SchemaAST.AST): boolean {
  return (
    SchemaAST.isObjects(ast) &&
    (ast.propertySignatures.length > 0 || ast.indexSignatures.length > 0)
  );
}

/**
 * True when every member of `original` was secret-shaped and got stripped from `transformed`,
 * leaving it empty — as opposed to an `Objects` node that was already empty in the source schema,
 * which must pass through as a permissive leaf rather than being treated as secret-shaped.
 */
function isAllSecretCollapsedContainer(
  original: SchemaAST.AST,
  transformed: SchemaAST.AST,
): boolean {
  return hasObjectMembers(original) && !hasObjectMembers(transformed);
}

/**
 * Marks `ast` optional through the public `Schema.optionalKey` combinator; the installed `effect`
 * release doesn't export `SchemaAST.optionalKey` directly.
 */
function toOptionalAst(ast: SchemaAST.AST): SchemaAST.AST {
  return Schema.optionalKey(Schema.make<Schema.Codec<unknown>>(ast)).ast;
}

/**
 * `Suspend` nodes fall through untouched; no recursive schema reaches this walk today. A test
 * fails loudly if one is introduced, rather than this silently mishandling the recursion.
 */
function toDeepOptionalHostedAst(ast: SchemaAST.AST): SchemaAST.AST {
  if (SchemaAST.isObjects(ast)) {
    const propertySignatures = ast.propertySignatures.flatMap((property) => {
      if (isSecretAst(property.type)) {
        return [];
      }
      const transformedType = toDeepOptionalHostedAst(property.type);
      if (isAllSecretCollapsedContainer(property.type, transformedType)) {
        return [];
      }
      return [new SchemaAST.PropertySignature(property.name, toOptionalAst(transformedType))];
    });
    const indexSignatures = ast.indexSignatures.flatMap((indexSignature) => {
      if (isSecretAst(indexSignature.type)) {
        return [];
      }
      const transformedType = toDeepOptionalHostedAst(indexSignature.type);
      if (isAllSecretCollapsedContainer(indexSignature.type, transformedType)) {
        return [];
      }
      return [new SchemaAST.IndexSignature(indexSignature.parameter, transformedType)];
    });
    return new SchemaAST.Objects(
      propertySignatures,
      indexSignatures,
      ast.annotations,
      undefined,
      undefined,
      ast.context,
      undefined,
    );
  }
  if (SchemaAST.isArrays(ast)) {
    return ast;
  }
  if (SchemaAST.isUnion(ast)) {
    return new SchemaAST.Union(
      ast.types.map(toDeepOptionalHostedAst),
      ast.options,
      ast.annotations,
      ast.checks,
      ast.encoding,
      ast.context,
      ast.encodingChecks,
    );
  }
  return ast;
}

// Field-picked literally rather than derived from `HOSTED_SECTION_KEYS`: `Schema.Struct`'s field
// type is inferred per-property from a literal object, which a programmatic pick would lose.
const hostedSectionsStruct = Schema.Struct({
  api: CliConfigSchema.fields.api,
  auth: CliConfigSchema.fields.auth,
  db: CliConfigSchema.fields.db,
  realtime: CliConfigSchema.fields.realtime,
  storage: CliConfigSchema.fields.storage,
  compute: CliConfigSchema.fields.compute,
  experimental: CliConfigSchema.fields.experimental,
});

// Must name the same seven keys as `HOSTED_SECTION_KEYS`; a test asserts they match rather than
// an import-time check, so a config-module import can't crash a consumer's process.
const projectConfigAst = toDeepOptionalHostedAst(SchemaAST.toType(hostedSectionsStruct.ast));

/**
 * The runtime shape {@link projectConfigAst} validates: {@link ProjectConfig} minus
 * `_apiResponse`, which is non-enumerable and has no runtime representation to check.
 */
type ProjectConfigSchemaType = Omit<ProjectConfig, "_apiResponse">;

/**
 * Runtime validator for {@link ProjectConfig}, exposed as both an Effect `Schema.Codec` and a
 * spec-compliant Standard Schema (`~standard`) on the same object.
 *
 * Annotated explicitly because the inferred type names `@standard-schema/spec` transitively,
 * which tsc can't portably emit into a declaration file unless it's a direct dependency.
 */
export const ProjectConfigSchema: StandardSchemaV1<
  ProjectConfigSchemaType,
  ProjectConfigSchemaType
> &
  Schema.Codec<ProjectConfigSchemaType> = Schema.toStandardSchemaV1(
  Schema.make<Schema.Codec<ProjectConfigSchemaType>>(projectConfigAst),
);

/** JSON Schema (draft 2020-12) rendering of {@link ProjectConfigSchema}. */
export function toProjectConfigJsonSchema() {
  const document = Schema.toJsonSchemaDocument(ProjectConfigSchema);
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    ...document.schema,
    ...(Object.keys(document.definitions).length > 0 ? { $defs: document.definitions } : {}),
  };
}
