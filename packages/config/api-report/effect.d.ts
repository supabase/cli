export * from "./index.ts";
import type { Effect } from "effect";
import type { LoadCliConfigOptions } from "./config-document.ts";
import type { ResolvedCliConfigValue, ResolveCliConfigOptions } from "./lib/resolve.ts";
import * as io from "./io.ts";
import type { CliProjectEnvironment } from "./project.ts";
export { configJsonPath, configTomlPath, saveCliConfig } from "./io.ts";
/**
 * Narrowed to the public `LoadCliConfigOptions` (no `goViperCompat`). The
 * underlying implementation in `./io.ts` is typed against the wider
 * `InternalLoadCliConfigOptions` (a strict superset — one additional optional
 * field), so assigning it here is a safe, cast-free narrowing: a function
 * accepting the wider options type is assignable to a variable typed to
 * accept only the narrower one. `@supabase/config/internal` re-exports this
 * same runtime function typed to additionally show `goViperCompat`.
 */
export declare const loadCliConfig: (cwd: string, options?: LoadCliConfigOptions) => ReturnType<typeof io.loadCliConfig>;
/** See {@link loadCliConfig}'s doc comment for the narrowing rationale. */
export declare const loadCliConfigFile: (filePath: string, options?: LoadCliConfigOptions) => ReturnType<typeof io.loadCliConfigFile>;
export { inferFunctionsManifest } from "./functions-manifest.ts";
export { loadDotEnvFile, loadCliProjectEnvironment } from "./project.ts";
/**
 * Explicit named exports take precedence over `export * from "./index.ts"`
 * above for a shared name (ESM re-export resolution), so these Effect-typed
 * variants deliberately shadow `./index.ts`'s plain sync
 * `resolveCliConfigValue`/`resolveCliConfigSubtree` on this subpath — the
 * Effect-typed variant wins on `./effect`; the sync variant lives on `.`.
 *
 * Narrowed to the public `ResolveCliConfigOptions` (no `goViperCompat`) for
 * the same reason as {@link loadCliConfig} above; `@supabase/config/internal`
 * re-exports these same runtime functions typed to additionally show
 * `goViperCompat`.
 */
export declare const resolveCliConfigValue: <T>(value: T, cliProjectEnv: Pick<CliProjectEnvironment, "values">, configPath: string, options?: ResolveCliConfigOptions) => Effect.Effect<ResolvedCliConfigValue<T>>;
/** See {@link resolveCliConfigValue}'s doc comment for the shadowing and narrowing rationale. */
export declare const resolveCliConfigSubtree: <T>(value: T, cliProjectEnv: Pick<CliProjectEnvironment, "values">, pathPrefix: string, options?: ResolveCliConfigOptions) => Effect.Effect<ResolvedCliConfigValue<T>>;
export { findCliProjectPaths, findCliProjectRoot } from "./paths.ts";
export { cliConfigStoreLayer } from "./cli-config.layer.ts";
export { CliConfigStore } from "./cli-config.service.ts";
