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
 * pins `@standard-schema/spec` as a direct dependency instead.
 */
export declare const ProjectConfigSchema: StandardSchemaV1<ProjectConfigSchemaType, ProjectConfigSchemaType> & Schema.Codec<ProjectConfigSchemaType>;
/** JSON Schema (draft 2020-12) rendering of {@link ProjectConfigSchema}, mirroring `../base.ts`'s `toCliConfigJsonSchema`. */
export declare function toProjectConfigJsonSchema(): {
    $schema: string;
    $defs?: import("effect/JsonSchema").Definitions | undefined;
};
export {};
