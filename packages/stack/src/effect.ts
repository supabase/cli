// @supabase/stack/effect — advanced Effect and low-level APIs.
// Platform-agnostic: pass platformFactory/daemonEntryPoint from @supabase/stack.

export type { LogEntry } from "@supabase/process-compose";
export type { StackServiceStatus } from "./StackServiceState.ts";
export { StackServiceState, fromRawServiceState } from "./StackServiceState.ts";

export {
  BinaryNotFoundError,
  ChecksumMismatchError,
  DockerPullError,
  DownloadError,
  PortConflictError,
  StackBuildError,
  StackError,
  toStackError,
} from "./errors.ts";

export type { PlatformInfo } from "./Platform.ts";
export {
  authAssetName,
  detectPlatform,
  postgresAssetName,
  postgrestAssetName,
} from "./Platform.ts";

export type { BinarySpec } from "./BinaryResolver.ts";
export { BinaryResolver } from "./BinaryResolver.ts";

export type { ServiceResolution } from "./resolve.ts";
export { resolveService } from "./resolve.ts";

export type { PrefetchOptions, PrefetchResult } from "./prefetch.ts";
export { prefetch } from "./prefetch.ts";

export {
  defaultJwtSecret,
  defaultPublishableKey,
  defaultSecretKey,
  generateJwt,
  JwtGenerator,
} from "./JwtGenerator.ts";

export type { AllocatedPorts, PortInput } from "./PortAllocator.ts";
export {
  allocatePorts,
  DEFAULT_API_PORT,
  DEFAULT_DB_PORT,
  PortAllocationError,
} from "./PortAllocator.ts";

export type { ProxyConfig } from "./ApiProxy.ts";
export { ApiProxy } from "./ApiProxy.ts";

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
  ResolvedAnalyticsConfig,
  ResolvedAuthConfig,
  ResolvedEdgeRuntimeConfig,
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
  StackConfig,
  StorageConfig,
  StudioConfig,
  VectorConfig,
} from "./StackBuilder.ts";
export { StackBuilder } from "./StackBuilder.ts";

export type { EdgeRuntimeReloadConfig, StackInfo } from "./Stack.ts";
export { EdgeRuntimeReloadConfigSchema, Stack } from "./Stack.ts";
export type {
  FunctionsConfig,
  FunctionsRuntimeConfig,
  ResolvedFunctionsConfig,
} from "./functions.ts";
export {
  configureFunctionsRuntime,
  functionsRuntimeConfigFileName,
  functionsRuntimeConfigPath,
  resolveFunctionsRuntimeConfig,
} from "./functions.ts";

export type { AvailableServiceVersionUpdate, ServiceName, VersionManifest } from "./versions.ts";
export {
  DEFAULT_VERSIONS,
  diffPinnedAndAvailableVersions,
  dockerImageForService,
  fillServiceVersionManifest,
  fullVersionManifest,
  IMAGE_TAG_PREFIX,
  normalizeServiceVersion,
  normalizeServiceVersions,
  SERVICE_NAMES,
} from "./versions.ts";
export type {
  StackVersionOverride,
  StackVersionPlan,
  StackVersionPlanInput,
} from "./version-plan.ts";
export { planStackVersions } from "./version-plan.ts";

export {
  DEFAULT_MANAGED_STACK_NAME,
  defaultManagedProjectStacksRoot,
  defaultManagedStackRoot,
  defaultManagedProjectsRoot,
  displayNameForProjectDir,
  projectKeyForProjectDir,
} from "./paths.ts";

export type { StackState } from "./StateManager.ts";
export {
  InvalidStackMetadataError,
  InvalidStackStateError,
  NoRunningStackError,
  StackAlreadyRunningError,
  StackMetadataNotFoundError,
  UnsupportedStackMetadataVersionError,
  projectStateManagerPathsFromRoot,
  StateManager,
  StateNotFoundError,
} from "./StateManager.ts";

export type { PartialVersionManifest, StackMetadata } from "./StackMetadata.ts";
export {
  PartialVersionManifestSchema,
  StackMetadataSchema,
  STACK_METADATA_SCHEMA_VERSION,
  runningServiceVersionsForConfig,
  stackMetadata,
} from "./StackMetadata.ts";

export { DaemonServer } from "./DaemonServer.ts";
export { RemoteStack } from "./RemoteStack.ts";
export { UnixHttpClient, UnixHttpClientError } from "./UnixHttpClient.ts";

export type {
  PlatformFactory,
  PlatformLayer,
  PlatformServices,
  ReadyOptions,
  StackHandle,
} from "./createStack.ts";
export {
  createStack,
  defaultManagedStackName,
  projectDaemonLayer,
  resolveConfig,
  resolveDaemonConfig,
} from "./createStack.ts";

export type { DaemonConfig } from "./layers.ts";
export { connectLayer, DaemonStartError, daemonLayer, foregroundLayer } from "./layers.ts";
export type { ManagedStack } from "./managed-stack.ts";
export { resolveManagedStack } from "./managed-stack.ts";

export type { StackSummary } from "./discovery.ts";
export {
  DaemonStillRunningError,
  deleteManagedStackPersistence,
  listStacks,
  resolveStackSummary,
  stopDaemon,
} from "./discovery.ts";

export type {
  DaemonErrorMessage,
  DaemonHttpServerFactory,
  DaemonMessage,
  DaemonStartedMessage,
  DaemonStartMessage,
} from "./daemon.ts";
