// @supabase/stack/internals — internal APIs for CLI integration
// These are not part of the public API and may change without notice.

// All public exports
export * from "./index.ts";

// Internal errors
export {
  BinaryNotFoundError,
  ChecksumMismatchError,
  DockerPullError,
  DownloadError,
  PortConflictError,
  StackBuildError,
} from "./errors.ts";

// Platform detection
export type { PlatformInfo } from "./Platform.ts";
export {
  authAssetName,
  detectPlatform,
  postgresAssetName,
  postgrestAssetName,
} from "./Platform.ts";

// Binary resolution
export type { BinarySpec } from "./BinaryResolver.ts";
export { BinaryResolver } from "./BinaryResolver.ts";

// Service resolution
export { resolveService } from "./resolve.ts";

// Prefetching
export { prefetch } from "./prefetch.ts";

// JWT generation
export {
  defaultJwtSecret,
  defaultPublishableKey,
  defaultSecretKey,
  generateJwt,
  JwtGenerator,
} from "./JwtGenerator.ts";

// Port allocation
export type { AllocatedPorts, PortInput } from "./PortAllocator.ts";
export {
  allocatePorts,
  DEFAULT_API_PORT,
  DEFAULT_DB_PORT,
  PortAllocationError,
} from "./PortAllocator.ts";

// API proxy
export type { ProxyConfig } from "./ApiProxy.ts";
export { ApiProxy } from "./ApiProxy.ts";

// Stack builder
export type {
  ResolvedAnalyticsConfig,
  ResolvedAuthConfig,
  ResolvedImgproxyConfig,
  ResolvedMailpitConfig,
  ResolvedPgmetaConfig,
  ResolvedPoolerConfig,
  ResolvedPostgresConfig,
  ResolvedPostgrestConfig,
  ResolvedRealtimeConfig,
  ResolvedStackConfig,
  ResolvedStorageConfig,
  ResolvedStudioConfig,
  ResolvedVectorConfig,
} from "./StackBuilder.ts";
export { StackBuilder } from "./StackBuilder.ts";

// Stack orchestration
export type { StackInfo } from "./Stack.ts";
export { Stack } from "./Stack.ts";

// Docker image helpers
export { dockerImageForService } from "./versions.ts";

// State management
export type { StackState } from "./StateManager.ts";
export {
  NoRunningStackError,
  StackAlreadyRunningError,
  StateManager,
  StateNotFoundError,
} from "./StateManager.ts";

// Daemon server
export { DaemonServer } from "./DaemonServer.ts";

// Remote stack (HTTP client to daemon)
export { RemoteStack } from "./RemoteStack.ts";

// Config resolution
export {
  defaultManagedStackName,
  projectDaemonLayer,
  resolveConfig,
  resolveDaemonConfig,
} from "./createStack.ts";

// Layer factories
export type { DaemonConfig } from "./layers.ts";
export { connectLayer, DaemonStartError, daemonLayer, foregroundLayer } from "./layers.ts";
export type { ManagedStack } from "./managed-stack.ts";
export { resolveManagedStack } from "./managed-stack.ts";

// Discovery
export type { StackSummary } from "./discovery.ts";
export {
  DaemonStillRunningError,
  deleteManagedStackPersistence,
  listStacks,
  stopDaemon,
} from "./discovery.ts";

// Daemon IPC types and factories (used by CLI to fork daemon process)
export type {
  DaemonErrorMessage,
  DaemonHttpServerFactory,
  DaemonMessage,
  DaemonStartedMessage,
  DaemonStartMessage,
} from "./daemon.ts";
