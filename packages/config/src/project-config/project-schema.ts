import type { StandardSchemaV1 } from "@standard-schema/spec";
import { Schema, SchemaAST } from "effect";
import { CliConfigSchema } from "../base.ts";
import { HOSTED_SECTION_KEYS } from "./hosted-sections.ts";
import type { ProjectConfig } from "./project-config.ts";

/**
 * Runtime companion to {@link ProjectConfig} (`./project-config.ts`) — a
 * schema that VALIDATES the same sparse hosted-section overlay
 * `ProjectConfig` only describes at compile time. Derived from
 * {@link CliConfigSchema} (`../base.ts`), never hand-declared, so the two can
 * never independently drift: every leaf type, annotation, and leaf-level
 * check traces back to the exact schema `base.ts` decodes a config document
 * with.
 *
 * Derivation, in order:
 *
 * 1. {@link hostedSectionsStruct} picks the seven {@link HOSTED_SECTION_KEYS}
 *    fields off `CliConfigSchema.fields` and rebuilds a fresh `Schema.Struct`
 *    from them — the same field schemas `CliConfigSchema` itself embeds, not
 *    copies.
 * 2. `SchemaAST.toType` strips every encoding/transformation (decoding
 *    defaults, `env()` deferred substitution, …), leaving the DECODED shape —
 *    exactly what `ProjectConfig` describes; a `ProjectConfig` value is never
 *    re-encoded.
 * 3. {@link toDeepOptionalHostedAst} then recursively rebuilds the result:
 *    - In every `Objects` node (struct OR record), drops any
 *      `PropertySignature`/`IndexSignature` whose value AST carries the
 *      `x-secret` annotation (ADR 0019 rule 5 — `fromConfigDocument`/
 *      `fromApiProjectConfig` never populate a secret leaf either), the same
 *      detection `../lib/secret-paths.ts`'s own walk uses. A container whose
 *      value type consists ENTIRELY of secret leaves (e.g. `db.vault`, a
 *      `Record<string, secret()>`) ends up an empty `Objects` node (no
 *      surviving properties or index signatures) — `SchemaAST`'s own
 *      documented behavior for that shape is "accepts any value except
 *      `null`/`undefined`", which is the closest a schema can get to "this
 *      container held nothing but secrets, so nothing concrete is left to
 *      validate here" without special-casing an empty-object type that JSON
 *      Schema has no way to express either.
 *    - Wraps every SURVIVING property in `optionalKey` (via
 *      {@link toOptionalAst}), recursing into its type — mirroring
 *      `DeepPartial`'s `{ readonly [K in keyof T]?: DeepPartial<T[K]> }`
 *      mapped type (`../sparse.ts`) at every object level reached, and
 *      recursing the same way into index-signature VALUE types (matching
 *      `DeepPartial`'s recursion into a `Record`'s value type —
 *      `Record<string, X>` deep-partializes to `Record<string,
 *      DeepPartial<X>>`, not `X` verbatim).
 *    - Leaves an `Arrays` node completely untouched, INCLUDING its element
 *      types: `DeepPartial` special-cases arrays to pass `T` through
 *      verbatim rather than partializing element types (`../sparse.ts`), and
 *      no `x-secret` leaf sits inside an array anywhere in this schema
 *      (`../lib/secret-paths.ts`'s own docstring), so there is nothing this
 *      walk would otherwise need to change there anyway.
 *    - Strips every `checks` array attached DIRECTLY to an `Objects` node —
 *      the cross-field business-rule refinements this repo attaches with
 *      `.check()` on a whole struct (`requiredWhenEnabled` in
 *      `../auth/email.ts`/`../auth/providers.ts`, `validateSmsProviderSwitch`
 *      in `../auth/sms.ts`) encode invariants a deliberately sparse overlay
 *      cannot generally satisfy — e.g. `{ auth: { email: { smtp: { enabled:
 *      true } } } }` with no `host` yet is a legal, if incomplete,
 *      `ProjectConfig` fragment, but `requiredWhenEnabled("host", ...)` would
 *      reject it. Every LEAF-level check (`Schema.Number.check(isInt(),
 *      isGreaterThanOrEqualTo(0))`, `Schema.isPattern(...)`, port-range
 *      bounds, …) lives on a non-`Objects` node and is left untouched.
 *    - Recurses into `Union` members (e.g. `storage.file_size_limit`'s
 *      `Schema.Union([String, Number])`, and every `Schema.Literals`-backed
 *      enum, which V4 also compiles to a `Union`) and `Suspend` thunks, so a
 *      secret-bearing or object-shaped member nested inside either would
 *      still be reached. Every other node kind (every leaf: `String`,
 *      `Number`, `Boolean`, `Literal`, …) is returned unchanged — there is
 *      nothing further to drop or partialize on a leaf. This module's own AST
 *      node kinds are enumerated explicitly, via each class's PUBLIC
 *      constructor, rather than through a generic `.recur()`-style
 *      mechanism: unlike `.repos/effect`'s vendored source, the installed
 *      `effect` release's own `AST#recur` is `@internal` (absent from its
 *      published `.d.ts`), so a truly generic fallback isn't available
 *      through the public API surface this package is allowed to depend on.
 *
 * `_apiResponse` (ADR 0019) is deliberately NOT part of this schema: it's
 * attached as a non-enumerable property that ordinary decode/validation can
 * never see, so there is nothing here for a schema to describe.
 *
 * Never `additionalProperties: false` ({@link toProjectConfigJsonSchema}
 * passes `{ additionalProperties: true }` to `Schema.toJsonSchemaDocument`,
 * and `ProjectConfigSchema` itself is never decoded with
 * `onExcessProperty: "error"`): a `ProjectConfig` value can carry extra own
 * keys a given schema VERSION doesn't yet model (a registry-mapped field a
 * future release adds), and JSON Schema's own default is permissive — this
 * derivation matches that norm rather than rejecting anything unrecognized.
 */
function isSecretAst(ast: SchemaAST.AST): boolean {
  return ast.annotations?.["x-secret"] === true;
}

/**
 * Marks `ast` optional through the PUBLIC `Schema.optionalKey` combinator
 * (`Schema.optionalKey(Schema.make(ast)).ast`) rather than the internal
 * `SchemaAST.optionalKey` this repo's vendored `.repos/effect` snapshot
 * exposes publicly but the installed `effect` release does not — see this
 * module's own doc comment. `Schema.make` performs no structural check
 * against the throwaway `unknown` `Codec` parameter here; only `ast` itself
 * (read straight back off the wrapped schema) is used.
 */
function toOptionalAst(ast: SchemaAST.AST): SchemaAST.AST {
  return Schema.optionalKey(Schema.make<Schema.Codec<unknown>>(ast)).ast;
}

function toDeepOptionalHostedAst(ast: SchemaAST.AST): SchemaAST.AST {
  if (SchemaAST.isObjects(ast)) {
    const propertySignatures = ast.propertySignatures
      .filter((property) => !isSecretAst(property.type))
      .map(
        (property) =>
          new SchemaAST.PropertySignature(
            property.name,
            toOptionalAst(toDeepOptionalHostedAst(property.type)),
          ),
      );
    const indexSignatures = ast.indexSignatures
      .filter((indexSignature) => !isSecretAst(indexSignature.type))
      .map(
        (indexSignature) =>
          new SchemaAST.IndexSignature(
            indexSignature.parameter,
            toDeepOptionalHostedAst(indexSignature.type),
          ),
      );
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
      ast.mode,
      ast.annotations,
      ast.checks,
      ast.encoding,
      ast.context,
      ast.encodingChecks,
    );
  }
  if (SchemaAST.isSuspend(ast)) {
    return new SchemaAST.Suspend(
      () => toDeepOptionalHostedAst(ast.thunk()),
      ast.annotations,
      ast.checks,
      ast.encoding,
      ast.context,
    );
  }
  return ast;
}

// A literal field-picking object, not a `HOSTED_SECTION_KEYS.map(...)`
// reflection: `Schema.Struct`'s field type is inferred per-property from a
// literal object type, which a programmatic pick loses without an `as` cast
// (disallowed by this repo's typing policy) to restore. Each field schema
// below is still the exact one `CliConfigSchema` itself embeds (`../base.ts`),
// never a copy.
const hostedSectionsStruct = Schema.Struct({
  api: CliConfigSchema.fields.api,
  auth: CliConfigSchema.fields.auth,
  db: CliConfigSchema.fields.db,
  realtime: CliConfigSchema.fields.realtime,
  storage: CliConfigSchema.fields.storage,
  workers: CliConfigSchema.fields.workers,
  experimental: CliConfigSchema.fields.experimental,
});

// The literal pick above still names the same seven keys as
// `HOSTED_SECTION_KEYS` by hand, since a type-safe `Schema.Struct` field
// object can't be built from an array without an `as` cast — this guard
// catches the two lists drifting apart (an edit to one without the other) at
// import time instead of silently validating the wrong section set.
const pickedHostedSectionKeys = Object.keys(hostedSectionsStruct.fields).toSorted();
const declaredHostedSectionKeys = HOSTED_SECTION_KEYS.toSorted();
if (JSON.stringify(pickedHostedSectionKeys) !== JSON.stringify(declaredHostedSectionKeys)) {
  throw new Error(
    "project-schema.ts's picked hosted-section fields drifted from HOSTED_SECTION_KEYS",
  );
}

const projectConfigAst = toDeepOptionalHostedAst(SchemaAST.toType(hostedSectionsStruct.ast));

/**
 * The runtime shape {@link projectConfigAst} validates: {@link ProjectConfig}
 * minus `_apiResponse`, which — being non-enumerable and never serialized —
 * has no runtime representation for a schema to check. `Schema.make` performs
 * no structural verification against this annotation (the same trust-the-
 * caller contract as effect's own `Json: Codec<Json> = make(SchemaAST.Json)`
 * precedent); the type-level pin in `./project-schema.unit.test.ts` cross-
 * checks this exact type expression against `ProjectConfig` independently, so
 * a future edit to either side that silently drifts fails to compile there.
 */
type ProjectConfigSchemaType = Omit<ProjectConfig, "_apiResponse">;

/**
 * Runtime validation for {@link ProjectConfig} — both an Effect-native schema
 * (decode/encode, `.ast`, …) and a spec-compliant Standard Schema
 * (`~standard`), since {@link Schema.toStandardSchemaV1} augments and returns
 * the SAME object rather than wrapping it in a second value.
 *
 * Annotated explicitly (rather than left inferred) because the inferred type
 * names `StandardSchemaV1` from `@standard-schema/spec` — a package reachable
 * only transitively through `effect` under pnpm's strict `node_modules`
 * isolation — which tsc's declaration emit refuses to synthesize into
 * `project-schema.d.ts` as non-portable. Explicitly importing the type here
 * pins `@standard-schema/spec` as a direct dependency instead.
 */
export const ProjectConfigSchema: StandardSchemaV1<
  ProjectConfigSchemaType,
  ProjectConfigSchemaType
> &
  Schema.Codec<ProjectConfigSchemaType> = Schema.toStandardSchemaV1(
  Schema.make<Schema.Codec<ProjectConfigSchemaType>>(projectConfigAst),
);

/** JSON Schema (draft 2020-12) rendering of {@link ProjectConfigSchema}, mirroring `../base.ts`'s `toCliConfigJsonSchema`. */
export function toProjectConfigJsonSchema() {
  const document = Schema.toJsonSchemaDocument(ProjectConfigSchema, {
    additionalProperties: true,
  });
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    ...document.schema,
    ...(Object.keys(document.definitions).length > 0 ? { $defs: document.definitions } : {}),
  };
}
