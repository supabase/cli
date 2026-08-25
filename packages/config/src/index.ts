/**
 * Pure, browser/edge-safe entrypoint. Must never export an Effect-returning
 * function, nor pull `@effect/platform-*` or `node:`/`bun:` modules into its
 * transitive graph. Effect-core `FileSystem`/`Path` TAG references reachable
 * from this graph are fine — they're inert without a platform layer provided.
 * File IO and Effect-native services live at `@supabase/config/io` and
 * `@supabase/config/effect`.
 */
export {
  CliConfigSchema,
  toCliConfigJsonSchema,
  type CliConfig,
  type CliConfigJson,
} from "./base.ts";
export {
  DuplicateRemoteProjectIdError,
  InvalidRemoteProjectIdError,
  MissingCliConfigValueError,
  CliConfigParseError,
  CliProjectEnvParseError,
} from "./errors.ts";
export type { ConfigFormat } from "./config-format.ts";
export {
  type LoadedCliConfig,
  type LoadCliConfigOptions,
  type CliConfigValueOrigin,
  type CliConfigValueSource,
  type SaveCliConfigOptions,
  encodeCliConfigToJson,
  encodeCliConfigToToml,
  cliConfigValueSourceAt,
} from "./config-document.ts";
export {
  edgeFunctionDenoConfigFileName,
  edgeFunctionEntrypointFileName,
  edgeFunctionsDirectoryName,
  type FunctionsManifest,
  type ResolvedFunctionConfig,
} from "./functions-manifest-model.ts";
export type {
  LoadCliProjectEnvironmentOptions,
  CliProjectEnvironment,
  ResolvedCliConfigValue,
  ResolveCliConfigOptions,
} from "./project.ts";
export type { CliProjectPaths } from "./paths.ts";
export { CLI_CONFIG_SCHEMA_URL } from "./schema-metadata.ts";
export {
  type BaseCliConfig,
  type SparseCliConfig,
  getDefaultCliConfig,
  omitDefaultValues,
  subtractCliConfig,
} from "./sparse.ts";
export { KONG_LOCAL_CA_CERT } from "./tls.ts";
export { ENV_CAPTURE_REGEX } from "./lib/env.ts";
