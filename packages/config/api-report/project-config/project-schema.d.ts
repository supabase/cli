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
 *      value type consists ENTIRELY of secret leaves (`db.vault`, a
 *      `Record<string, secret()>`) ends up an empty `Objects` node this way
 *      (no surviving properties or index signatures) — `SchemaAST`'s own
 *      documented behavior for that shape is "accepts any value except
 *      `null`/`undefined`", the closest a schema can get to "this container
 *      held nothing but secrets, so nothing concrete is left to validate
 *      here" without special-casing an empty-object type JSON Schema has no
 *      way to express either. Two OTHER hosted-section leaves land on that
 *      same empty-`Objects` shape for an unrelated reason:
 *      `storage.analytics.buckets.*` and `storage.vector.buckets.*` are
 *      already `Schema.Struct({})` at the SOURCE level (`../storage.ts`) —
 *      genuinely empty structs, untouched by this walk's secret-stripping.
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
import { Schema } from "effect";
import type { ProjectConfig } from "./project-config.ts";
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
export declare const ProjectConfigSchema: StandardSchemaV1<ProjectConfigSchemaType, ProjectConfigSchemaType> & Schema.Codec<ProjectConfigSchemaType>;
/** JSON Schema (draft 2020-12) rendering of {@link ProjectConfigSchema}, mirroring `../base.ts`'s `toCliConfigJsonSchema`. */
export declare function toProjectConfigJsonSchema(): {
    $schema: string;
    $defs?: import("effect/JsonSchema").Definitions | undefined;
};
export {};
