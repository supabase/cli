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
  ReadinessPolicy,
  ReadyOptions,
  ServicePolicy,
  ServicePolicyManifest,
  StackMode,
  StackConfig,
  StorageConfig,
  StudioConfig,
  VectorConfig,
} from "./StackConfig.ts";

export type { ServiceName, VersionManifest } from "./versions.ts";
export type { ServiceResolution, StackPreparationError } from "./StackPreparation.ts";
export type { PrefetchOptions, PrefetchResult } from "./prefetch.ts";
export type { StackHandle } from "./stackHandle.ts";
export { StackError } from "./errors.ts";
export { nativeLogRoot, nativeServiceLogPath, startNativeLogWriter } from "./NativeLogWriter.ts";
export type {
  FunctionsReloadConfig,
  FunctionsRuntimeConfig,
  ResolvedFunction,
  ResolvedFunctionsBundle,
} from "./functions.ts";
