import { Redacted } from "effect";
import type { CliProjectEnvironment } from "../project.ts";
type ResolvedString = string | Redacted.Redacted<string>;
export type ResolvedCliConfigValue<T> = T extends string ? ResolvedString : T extends ReadonlyArray<infer U> ? ReadonlyArray<ResolvedCliConfigValue<U>> : T extends Array<infer U> ? Array<ResolvedCliConfigValue<U>> : T extends Record<string, infer V> ? {
    readonly [K in keyof T]: ResolvedCliConfigValue<T[K]>;
} & {
    readonly [key: string]: ResolvedCliConfigValue<V>;
} : T extends object ? {
    readonly [K in keyof T]: ResolvedCliConfigValue<T[K]>;
} : T;
/**
 * Currently empty: this package's one `resolveCliConfigValue`/
 * `resolveCliConfigSubtree` option (`goViperCompat`) is internal-only — see
 * {@link InternalResolveCliConfigOptions} in `../project.ts`, exported from
 * `@supabase/config/internal`. Kept as a named type (rather than removed
 * entirely) so the public sync resolvers below have a stable options
 * parameter to extend if a public knob is ever added.
 */
export interface ResolveCliConfigOptions {
}
export declare function toPathSegments(path: string): ReadonlyArray<string>;
/**
 * Shared by the plain sync resolvers below and `../project.ts`'s
 * Effect-typed `resolveCliConfigValue`/`resolveCliConfigSubtree` (which wrap
 * this in `Effect.sync` and additionally accept the internal-only
 * `goViperCompat` option).
 */
export declare function resolveCliConfigValueAtPath(value: unknown, cliProjectEnv: Pick<CliProjectEnvironment, "values">, path: ReadonlyArray<string>, goViperCompat: boolean): unknown;
/**
 * Plain synchronous counterpart of `../project.ts`'s Effect-typed
 * `resolveCliConfigValue`, exported from `.` under the same name — `./effect`
 * re-exports the Effect-typed variant explicitly, which wins over this one's
 * star re-export through `./index.ts` (see `../effect.ts`'s doc comment).
 *
 * `cliProjectEnv` only needs `.values` (`Pick<CliProjectEnvironment, "values">`) —
 * a caller that already has a project's env values but not the full
 * `CliProjectEnvironment` shape (e.g. `paths`/`loadedPaths`/`sources`) can pass
 * `{ values }` directly instead of threading through the whole loaded object.
 */
export declare function resolveCliConfigValue<T>(value: T, cliProjectEnv: Pick<CliProjectEnvironment, "values">, configPath: string, _options?: ResolveCliConfigOptions): ResolvedCliConfigValue<T>;
/** See {@link resolveCliConfigValue}'s doc comment for why `cliProjectEnv` only needs `.values`. */
export declare function resolveCliConfigSubtree<T>(value: T, cliProjectEnv: Pick<CliProjectEnvironment, "values">, pathPrefix: string, _options?: ResolveCliConfigOptions): ResolvedCliConfigValue<T>;
export {};
