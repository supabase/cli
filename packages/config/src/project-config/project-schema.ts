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
 *      detection `../lib/secret-paths.ts`'s own walk uses. When that
 *      stripping empties out an `Objects` node that ORIGINALLY had at least
 *      one property/index signature — a container whose value type consists
 *      ENTIRELY of secret leaves, e.g. `db.vault` (a `Record<string,
 *      secret()>`) — the walk drops that property/index signature from its
 *      PARENT entirely instead of keeping an empty, accept-anything
 *      `Objects` node: an all-secret container is itself secret-shaped, the
 *      same as a single secret leaf, so `db.vault` never appears anywhere in
 *      `ProjectConfigSchema` at all. This is distinct from an `Objects` node
 *      that was ALREADY empty at the SOURCE level before any stripping —
 *      `storage.analytics.buckets.*` and `storage.vector.buckets.*` are
 *      genuinely empty `Schema.Struct({})`s (`../storage.ts`), untouched by
 *      this walk, and still pass through as accept-anything leaves — the
 *      derived schema must not be stricter than `CliConfigSchema` itself,
 *      which behaves identically for those two, genuinely-empty structs.
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
 *      reject it. Every LEAF-level check survives untouched, since it lives
 *      on a non-`Objects` node — today that's only `workers.*.instances`'s
 *      `Schema.Number.check(isInt(), isGreaterThanOrEqualTo(0))` and the
 *      `[workers]` record's own key pattern (`Schema.isPattern(...)` on
 *      `workerName`, `../workers.ts`). There is no port-range (or other
 *      numeric-bound) leaf check anywhere in this schema today.
 *    - Recurses into `Union` members (e.g. `storage.file_size_limit`'s
 *      `Schema.Union([String, Number])`, and every `Schema.Literals`-backed
 *      enum, which V4 also compiles to a `Union`), so a secret-bearing or
 *      object-shaped member nested inside one would still be reached. Every
 *      other node kind (every leaf: `String`, `Number`, `Boolean`,
 *      `Literal`, …) is returned unchanged — there is nothing further to
 *      drop or partialize on a leaf. This module's own AST node kinds are
 *      enumerated explicitly, via each class's PUBLIC constructor, rather
 *      than through a generic `.recur()`-style mechanism: unlike
 *      `.repos/effect`'s vendored source, the installed `effect` release's
 *      own `AST#recur` is `@internal` (absent from its published `.d.ts`),
 *      so a truly generic fallback isn't available through the public API
 *      surface this package is allowed to depend on.
 *      `./project-schema.unit.test.ts`'s AST-walk exhaustiveness guard walks
 *      the derived AST and fails loudly if a node kind outside this
 *      enumerated set (or a reintroduced `Suspend`, deliberately unhandled
 *      here — see {@link toDeepOptionalHostedAst}) ever appears, rather than
 *      silently mishandling it.
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
 * True when `original` was an `Objects` node with at least one member
 * (property or index signature) before secret-stripping, and `transformed` —
 * the same node's {@link toDeepOptionalHostedAst} result — ended up with
 * none: every member was secret-shaped and got dropped, so the container
 * itself is now secret-shaped too. Distinguishes that case from an `Objects`
 * node that was ALREADY empty at the source level (`storage.analytics.
 * buckets.*`/`storage.vector.buckets.*` — see this module's own doc
 * comment), which must pass through unchanged rather than being treated as
 * secret-shaped.
 */
function isAllSecretCollapsedContainer(
  original: SchemaAST.AST,
  transformed: SchemaAST.AST,
): boolean {
  return hasObjectMembers(original) && !hasObjectMembers(transformed);
}

/**
 * Marks `ast` optional through the PUBLIC `Schema.optionalKey` combinator
 * (`Schema.optionalKey(Schema.make(ast)).ast`) rather than the internal
 * `SchemaAST.optionalKey` this repo's vendored `.repos/effect` snapshot
 * exposes publicly but the installed `effect` release does not — see this
 * module's own doc comment. Conscious exception to this repo's `as`-cast
 * policy's spirit (a typed-constructor call standing in for one): `Schema.make`
 * performs no structural check against the throwaway `unknown` `Codec`
 * parameter here; only `ast` itself (read straight back off the wrapped
 * schema) is used.
 */
function toOptionalAst(ast: SchemaAST.AST): SchemaAST.AST {
  return Schema.optionalKey(Schema.make<Schema.Codec<unknown>>(ast)).ast;
}

/**
 * `Suspend` is deliberately UNHANDLED here (falls through to the final
 * `return ast` below, verbatim, untouched) rather than recursed into: no
 * `Schema.suspend`-backed recursive type is reachable from the seven hosted
 * sections today, so this is unreachable in practice, and
 * `./project-schema.unit.test.ts`'s AST-walk exhaustiveness guard fails
 * loudly the moment one is introduced — a reviewable prompt to design real
 * `Suspend` handling (thunk identity/`$defs` implications included) instead
 * of silently mishandling recursion.
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
      ast.mode,
      ast.annotations,
      ast.checks,
      ast.encoding,
      ast.context,
      ast.encodingChecks,
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
// object can't be built from an array without an `as` cast. The two lists
// drifting apart (an edit to one without the other) is caught by
// `./project-schema.unit.test.ts`'s own assertion against
// `ProjectConfigSchema.ast`'s top-level property names vs.
// `HOSTED_SECTION_KEYS`, not by an import-time throw here (CLI-2234) — a
// schema-module import should never be able to crash a consumer's process
// for a condition a test already covers.

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
 * pins `@standard-schema/spec` as a direct dependency instead. Conscious
 * exception to this repo's `as`-cast policy's spirit: `Schema.make`'s type
 * parameter here is asserted, not verified, against `projectConfigAst` — see
 * {@link ProjectConfigSchemaType}'s doc comment for the independent
 * compile-time cross-check that catches drift instead.
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
