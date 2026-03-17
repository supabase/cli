// @supabase/stack — shared runtime-agnostic types for conditional root entry points

export type { LogEntry } from "@supabase/process-compose";
export type { StackServiceStatus } from "./StackServiceState.ts";

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

export type { ServiceName, VersionManifest } from "./versions.ts";
export type { ServiceResolution } from "./resolve.ts";
export type { PrefetchOptions, PrefetchResult } from "./prefetch.ts";
export type { ReadyOptions, StackHandle } from "./createStack.ts";
