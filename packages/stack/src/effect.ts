// Platform-agnostic Effect contracts re-exported by the conditional @supabase/stack/effect entry.

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
  StackReadinessError,
  toStackError,
} from "./errors.ts";

export type { PlatformInfo } from "./Platform.ts";
export {
  authAssetName,
  detectPlatform,
  postgresAssetName,
  postgrestAssetName,
} from "./Platform.ts";

export type { ServiceResolution } from "./StackPreparation.ts";

export type { PrefetchOptions, PrefetchResult } from "./prefetch.ts";
export { prefetch } from "./prefetch.ts";

export {
  defaultJwtSecret,
  defaultPublishableKey,
  defaultSecretKey,
  generateJwt,
} from "./JwtGenerator.ts";

export type {
  AllocatedPorts,
  PortField,
  PortInput,
  PortLease,
  PortSelectionOptions,
} from "./PortAllocator.ts";
export {
  allocatePorts,
  DEFAULT_API_PORT,
  DEFAULT_DB_PORT,
  PortAllocationError,
  reserveAllocatedPorts,
  reservePorts,
} from "./PortAllocator.ts";

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
  ReadinessPolicy,
  ReadyOptions,
  StackConfig,
  StorageConfig,
  StudioConfig,
  VectorConfig,
} from "./StackConfig.ts";
export { DEFAULT_STACK_READINESS_POLICY, resolveReadinessPolicy } from "./StackConfig.ts";

export type { EdgeRuntimeReloadConfig, StackInfo } from "./Stack.ts";
export { EdgeRuntimeReloadConfigSchema, Stack } from "./Stack.ts";
export type {
  FunctionsReloadConfig,
  FunctionsRuntimeConfig,
  ResolvedFunction,
  ResolvedFunctionsBundle,
} from "./functions.ts";
export {
  clearFunctionsRuntimeConfig,
  configureFunctionsRuntime,
  FunctionsReloadConfigSchema,
  functionsRuntimeConfigFileName,
  functionsRuntimeConfigPath,
  ResolvedFunctionSchema,
  ResolvedFunctionsBundleSchema,
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

export type { ResolvedDaemonConfig } from "./StackConfig.ts";
export {
  defaultManagedStackName,
  resolveConfig,
  resolveDaemonConfig,
} from "./StackConfigResolver.ts";

export { connectLayer, DaemonStartError } from "./layers.ts";
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
