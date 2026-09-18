// Effect-native surface — superset of the default entrypoint.
export * from "./index.ts";
import type { Effect } from "effect";
import type { LoadCliConfigOptions } from "./config-document.ts";
import type { ResolvedCliConfigValue } from "./lib/resolve.ts";
import * as io from "./io.ts";
import type { CliProjectEnvironment } from "./project.ts";
import * as project from "./project.ts";

export { configJsonPath, configTomlPath, saveCliConfig } from "./io.ts";
export { validateCliConfig } from "./validate.ts";

/** Loads a CLI config document; the internal `goViperCompat` option is exposed only via `@supabase/config/internal`. */
export const loadCliConfig: (
  cwd: string,
  options?: LoadCliConfigOptions,
) => ReturnType<typeof io.loadCliConfig> = io.loadCliConfig;

/** Loads a CLI config document from an explicit file path; see {@link loadCliConfig}. */
export const loadCliConfigFile: (
  filePath: string,
  options?: LoadCliConfigOptions,
) => ReturnType<typeof io.loadCliConfigFile> = io.loadCliConfigFile;

export { inferFunctionsManifest } from "./functions-manifest.ts";
export { loadDotEnvFile, loadCliProjectEnvironment } from "./project.ts";

/**
 * Effect-typed counterpart to the sync `resolveCliConfigValue` exported from `.`; the internal
 * `goViperCompat` option is exposed only via `@supabase/config/internal`.
 */
export const resolveCliConfigValue: <T>(
  value: T,
  cliProjectEnv: Pick<CliProjectEnvironment, "values">,
  configPath: string,
) => Effect.Effect<ResolvedCliConfigValue<T>> = project.resolveCliConfigValue;

/** See {@link resolveCliConfigValue}. */
export const resolveCliConfigSubtree: <T>(
  value: T,
  cliProjectEnv: Pick<CliProjectEnvironment, "values">,
  pathPrefix: string,
) => Effect.Effect<ResolvedCliConfigValue<T>> = project.resolveCliConfigSubtree;

export { findCliProjectPaths, findCliProjectRoot } from "./paths.ts";
export { cliConfigStoreLayer } from "./cli-config.layer.ts";
export { CliConfigStore } from "./cli-config.service.ts";
