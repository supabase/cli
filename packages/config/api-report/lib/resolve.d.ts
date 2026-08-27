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
export declare function toPathSegments(path: string): ReadonlyArray<string>;
/**
 * Shared by the plain sync resolvers below and `../project.ts`'s
 * Effect-typed `resolveCliConfigValue`/`resolveCliConfigSubtree` (which wrap
 * this in `Effect.sync` and additionally accept the internal-only
 * `goViperCompat` option).
 *
 * Declared as an overload pair rather than a single generic signature: the
 * body's `unknown`-typed implementation signature is what lets
 * `interpolateValue`/`redactValue` (both genuinely `unknown -> unknown`,
 * since the recursion branches on runtime shape, not on `T`) flow straight
 * through to the return without an `as` cast — callers only ever see the
 * generic overload above, which resolves `T` from the argument and returns
 * `ResolvedCliConfigValue<T>` directly.
 */
export declare function resolveCliConfigValueAtPath<T>(value: T, cliProjectEnv: Pick<CliProjectEnvironment, "values">, path: ReadonlyArray<string>, goViperCompat: boolean): ResolvedCliConfigValue<T>;
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
 *
 * Has no options parameter: this package's one resolver knob (`goViperCompat`)
 * is internal-only — see `InternalResolveCliConfigOptions` in `../project.ts`,
 * exported from `@supabase/config/internal`. Adding a public knob later is a
 * non-breaking, additive change.
 */
export declare function resolveCliConfigValue<T>(value: T, cliProjectEnv: Pick<CliProjectEnvironment, "values">, configPath: string): ResolvedCliConfigValue<T>;
/** See {@link resolveCliConfigValue}'s doc comment for why `cliProjectEnv` only needs `.values`. */
export declare function resolveCliConfigSubtree<T>(value: T, cliProjectEnv: Pick<CliProjectEnvironment, "values">, pathPrefix: string): ResolvedCliConfigValue<T>;
export {};
