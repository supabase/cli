// @supabase/stack — shared runtime-agnostic types for conditional root entry points

export type { LogEntry } from "@supabase/process-compose";
export type { StackServiceStatus } from "./StackServiceState.ts";

export type {
  AnalyticsConfig,
  AuthConfig,
  EdgeRuntimeConfig,
  ImgproxyConfig,
  MailpitConfig,
  PgmetaConfig,
  PoolerConfig,
  PostgresConfig,
  PostgrestConfig,
  RealtimeConfig,
  StackConfig,
  StorageConfig,
  StudioConfig,
  VectorConfig,
} from "./StackBuilder.ts";

export type { ServiceName, VersionManifest } from "./versions.ts";
export type {
  ProvisionedServiceName,
  ProvisionedStackOptions,
  ProvisionedStackVersions,
} from "./provisionedStack.ts";
export { DEFAULT_VERSIONS, fillServiceVersionManifest, SERVICE_NAMES } from "./versions.ts";
export type { AllocatedPorts } from "./PortAllocator.ts";
export { PORT_FIELDS } from "./PortAllocator.ts";
export { postgresConnectionUrl, resolvePostgresPassword } from "./postgresCredentials.ts";
export { validateEnabledServiceDependencies } from "./serviceDependencies.ts";
export type { ServiceResolution } from "./resolve.ts";
export type { PrefetchOptions, PrefetchResult } from "./prefetch.ts";
export type { ReadyOptions, StackHandle } from "./createStack.ts";
export type { FunctionsConfig, FunctionsRuntimeConfig } from "./functions.ts";
export { UnixHttpClient, UnixHttpClientError } from "./UnixHttpClient.ts";
export { installMicroProfile } from "./pgconf.ts";
export { configureExtensionPreload } from "./extensionPreload.ts";
export type { ExtensionPreloadResult } from "./extensionPreload.ts";
