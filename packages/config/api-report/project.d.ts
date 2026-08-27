import { Effect, FileSystem } from "effect";
import { CliProjectEnvParseError } from "./errors.ts";
import { type ResolvedCliConfigValue, type ResolveCliConfigOptions } from "./lib/resolve.ts";
import { type CliProjectPaths } from "./paths.ts";
export interface CliProjectEnvironment {
    readonly paths: CliProjectPaths;
    readonly values: Readonly<Record<string, string>>;
    readonly loadedPaths: ReadonlyArray<string>;
    readonly sources: Readonly<Record<string, "ambient" | ".env" | ".env.local">>;
}
/** Parse one explicit dotenv file without applying ambient or project-local precedence. */
export declare const loadDotEnvFile: (path: string) => Effect.Effect<Record<string, string>, CliProjectEnvParseError | import("effect/PlatformError").PlatformError, FileSystem.FileSystem>;
export interface LoadCliProjectEnvironmentOptions {
    readonly cwd: string;
    readonly baseEnv?: Readonly<Record<string, string | undefined>>;
    /** See {@link FindCliProjectPathsOptions.search}. */
    readonly search?: boolean;
    /**
     * Skip reading/parsing `paths.envLocalPath` (`supabase/.env.local`)
     * entirely. Mirrors Go's `loadDefaultEnv` (`apps/cli-go/pkg/config/
     * config.go:1243-1250`), which omits `.env.local` from its candidate
     * filename list whenever `SUPABASE_ENV=test` — so a malformed or
     * intentionally non-test `.env.local` is invisible to Go in that mode and
     * must not fail config loading here either. Defaults to `false` so
     * existing callers that don't have a `SUPABASE_ENV` gate of their own
     * (`next/`, `secrets set`) are unaffected.
     */
    readonly skipEnvLocal?: boolean;
}
/**
 * Not covered by semver — exported from `@supabase/config/internal` only. See
 * that module's header for why.
 */
export interface InternalResolveCliConfigOptions extends ResolveCliConfigOptions {
    /**
     * Opt into Go/viper-parity `env()` matching (case-agnostic
     * `^env\((.*)\)$`). Defaults to `false`, which uses the pre-PR-#5765 strict
     * SCREAMING_SNAKE_CASE matcher (`ENV_CAPTURE_REGEX_STRICT`). Only the
     * Go-parity legacy shell sets this to `true`.
     */
    readonly goViperCompat?: boolean;
}
export declare const loadCliProjectEnvironment: (options: LoadCliProjectEnvironmentOptions) => Effect.Effect<{
    paths: {
        projectRoot: string;
        supabaseDir: string;
        configPath: string;
        envPath: string;
        envLocalPath: string;
    };
    values: Record<string, string>;
    loadedPaths: string[];
    sources: Record<string, ".env" | ".env.local" | "ambient">;
} | null, CliProjectEnvParseError | import("effect/PlatformError").PlatformError, FileSystem.FileSystem | import("effect/Path").Path>;
/**
 * Effect-typed counterpart of `./lib/resolve.ts`'s plain sync
 * `resolveCliConfigValue`, additionally accepting the internal-only
 * `goViperCompat` option (see {@link InternalResolveCliConfigOptions}).
 * `../effect.ts` re-exports this explicitly, which wins over the sync
 * version's star re-export through `./index.ts` (see that module's doc
 * comment on the deliberate shadowing) — `@supabase/config/internal`
 * re-exports this same function typed to show `goViperCompat`.
 *
 * `cliProjectEnv` only needs `.values` (`Pick<CliProjectEnvironment, "values">`) —
 * a caller that already has a project's env values but not the full
 * `CliProjectEnvironment` shape (e.g. `paths`/`loadedPaths`/`sources`) can pass
 * `{ values }` directly instead of threading through the whole loaded object.
 */
export declare function resolveCliConfigValue<T>(value: T, cliProjectEnv: Pick<CliProjectEnvironment, "values">, configPath: string, options?: InternalResolveCliConfigOptions): Effect.Effect<ResolvedCliConfigValue<T>>;
/** See {@link resolveCliConfigValue}'s doc comment for why `cliProjectEnv` only needs `.values`. */
export declare function resolveCliConfigSubtree<T>(value: T, cliProjectEnv: Pick<CliProjectEnvironment, "values">, pathPrefix: string, options?: InternalResolveCliConfigOptions): Effect.Effect<ResolvedCliConfigValue<T>>;
