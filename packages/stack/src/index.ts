// @supabase/stack — local Supabase stack management

// Re-exports from process-compose
export type { LogEntry } from "@supabase/process-compose";
export type { StackServiceStatus } from "./StackServiceState.ts";
export { StackServiceState } from "./StackServiceState.ts";

// Public error types
export { StackError, toStackError } from "./errors.ts";

// Stack configuration types
export type {
  AnalyticsConfig,
  AuthConfig,
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

// Service versioning
export type { ServiceName, VersionManifest } from "./versions.ts";
export { DEFAULT_VERSIONS } from "./versions.ts";

// Service resolution (for prefetch result type)
export type { ServiceResolution } from "./resolve.ts";

// Prefetching
export type { PrefetchOptions, PrefetchResult } from "./prefetch.ts";

// Public API
export type {
  PlatformFactory,
  PlatformLayer,
  PlatformServices,
  ReadyOptions,
  StackHandle,
} from "./createStack.ts";
export { createStack } from "./createStack.ts";
