import { Schema, SchemaAST } from "effect";
export declare const ENV_PATTERN = "^env\\((.*)\\)$";
export declare const ENV_CAPTURE_REGEX: RegExp;
export declare const ENV_CAPTURE_REGEX_STRICT: RegExp;
export declare function isEnvReference(value: string, goViperCompat: boolean): boolean;
interface EnvAnnotations extends Schema.Annotations.Documentation<string> {
    readonly secret?: true;
}
export declare const env: (annotations?: EnvAnnotations) => Schema.String;
interface SecretAnnotations extends Schema.Annotations.Documentation<string> {
}
export declare const secret: (annotations?: SecretAnnotations) => Schema.String;
/**
 * Pre-decode env() substitution + schema-aware coercion.
 *
 * Walks the raw parsed document and the schema AST in parallel. For every
 * string leaf matching `env(VAR)`:
 *   1. Substitutes `env[VAR]` if set AND non-empty, else preserves the
 *      literal verbatim (Go-parity with
 *      `apps/cli-go/pkg/config/decode_hooks.go:14-21`, which gates on
 *      `len(env) > 0` — a set-but-empty var, e.g. a dotenv `KEY=` line,
 *      leaves the `env(KEY)` literal untouched just like an unset one).
 *   2. If the schema at that path expects Number or Boolean, coerces the
 *      substituted string to the expected primitive — mirroring Go's
 *      mapstructure chain where `LoadEnvHook` returns a string that the next
 *      hook converts to the target type.
 *
 * Returns a new structure; does not mutate the input.
 */
export declare function interpolateEnvReferencesAgainstSchema(document: unknown, env: Readonly<Record<string, string>>, schema: {
    readonly ast: SchemaAST.AST;
}, options?: {
    readonly goViperCompat?: boolean;
    readonly onResolvedEnv?: (path: ReadonlyArray<string>) => void;
}): unknown;
export {};
