// @supabase/stack — shared runtime-agnostic types for conditional root entry points

export type { LogEntry } from "@supabase/process-compose";
export type { StackServiceStatus } from "./StackServiceState.ts";

export type {
  AnalyticsConfig,
  AuthConfig,
  DatabaseBootstrapConfig,
  DatabaseSeedFile,
  EdgeRuntimeConfig,
  ImgproxyConfig,
  MailpitConfig,
  PgmetaConfig,
  PoolerConfig,
  PostgresConfig,
  PostgrestConfig,
  RealtimeConfig,
  ReadinessPolicy,
  ReadyOptions,
  StackConfig,
  StorageConfig,
  StudioConfig,
  VectorConfig,
} from "./StackConfig.ts";

export type { ServiceName, VersionManifest } from "./versions.ts";
export type { ServiceResolution } from "./StackPreparation.ts";
export type { PrefetchOptions, PrefetchResult } from "./prefetch.ts";
export type { StackHandle } from "./createStack.ts";
export type {
  FunctionsConfigureConfig,
  FunctionsReloadConfig,
  FunctionsRuntimeConfig,
  ResolvedFunction,
  ResolvedFunctionsBundle,
} from "./functions.ts";
