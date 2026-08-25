/**
 * Pure, browser/edge-safe entrypoint. Must never export an Effect-returning
 * function, nor pull `@effect/platform-*` or `node:`/`bun:` modules into its
 * transitive graph. Effect-core `FileSystem`/`Path` TAG references reachable
 * from this graph are fine — they're inert without a platform layer provided.
 * File IO and Effect-native services live at `@supabase/config/io` and
 * `@supabase/config/effect`.
 */
export {
  ProjectConfigSchema,
  toProjectConfigJsonSchema,
  type ProjectConfig,
  type ProjectConfigJson,
} from "./base.ts";
export {
  DuplicateRemoteProjectIdError,
  InvalidRemoteProjectIdError,
  MissingProjectConfigValueError,
  ProjectConfigParseError,
  ProjectEnvParseError,
} from "./errors.ts";
export type { ConfigFormat } from "./config-format.ts";
export {
  type LoadedProjectConfig,
  type LoadProjectConfigOptions,
  type ProjectConfigValueOrigin,
  type ProjectConfigValueSource,
  type SaveProjectConfigOptions,
  encodeProjectConfigToJson,
  encodeProjectConfigToToml,
  projectConfigValueSourceAt,
} from "./config-document.ts";
export {
  edgeFunctionDenoConfigFileName,
  edgeFunctionEntrypointFileName,
  edgeFunctionsDirectoryName,
  type FunctionsManifest,
  type ResolvedFunctionConfig,
} from "./functions-manifest-model.ts";
export type {
  LoadProjectEnvironmentOptions,
  ProjectEnvironment,
  ResolvedProjectValue,
  ResolveProjectOptions,
} from "./project.ts";
export type { ProjectPaths } from "./paths.ts";
export { PROJECT_CONFIG_SCHEMA_URL } from "./schema-metadata.ts";
export {
  type BaseProjectConfig,
  type SparseProjectConfig,
  getDefaultProjectConfig,
  omitDefaultValues,
  subtractProjectConfig,
} from "./sparse.ts";
export { KONG_LOCAL_CA_CERT } from "./tls.ts";
export { ENV_CAPTURE_REGEX } from "./lib/env.ts";
