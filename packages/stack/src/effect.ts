// Platform-agnostic Effect contracts re-exported by the conditional @supabase/stack/effect entry.

export type { LogEntry } from "@supabase/process-compose";
export type { StackServiceStatus } from "./StackServiceState.ts";
export { StackServiceState, fromRawServiceState } from "./StackServiceState.ts";

export {
  BinaryHostCompatibilityError,
  BinaryManifestError,
  BinaryNotFoundError,
  BinaryRuntimeError,
  ChecksumMismatchError,
  DockerPullError,
  DownloadError,
  isDockerDaemonDownMessage,
  PortConflictError,
  StackBuildError,
  StackError,
  StackReadinessError,
  toStackError,
} from "./errors.ts";

export type { NativeTarget, PlatformInfo } from "./Platform.ts";
export { detectPlatform, nativeTargetForPlatform } from "./Platform.ts";

export type { ContainerRuntime, StackRuntimeSelection } from "./ContainerRuntime.ts";
export { selectStackRuntime, validateStackRuntime } from "./ContainerRuntime.ts";

export type { ServiceResolution, StackPreparationError } from "./StackPreparation.ts";

export type { PrefetchEffectOptions, PrefetchOptions, PrefetchResult } from "./prefetch.ts";
export { prefetch } from "./prefetch.ts";

export {
  defaultJwtSecret,
  defaultPublishableKey,
  defaultSecretKey,
  generateJwt,
} from "./JwtGenerator.ts";

export type {
  AllocatedPorts,
  ConfigPortKey,
  PortCatalogEntry,
  PortField,
  PortSet,
  ResolvedPorts,
} from "./PortCatalog.ts";
export type {
  PortLease,
  PortReservationRequest,
  PortSelection,
  PortSelectionOptions,
} from "./PortAllocator.ts";
export { allocatePortSet, PortAllocationError, reservePortSet } from "./PortAllocator.ts";
export {
  AllocatedPortsSchema,
  DEFAULT_API_PORT,
  DEFAULT_DB_PORT,
  DEFAULT_PORTS,
  PORT_CATALOG,
  PORT_FIELDS,
  PortSetSchema,
  ResolvedPortsSchema,
  runtimeOnlyPortFields,
  stickyPortFields,
} from "./PortCatalog.ts";
export { portFieldsForConfigInput, portFieldsForService } from "./ServicePorts.ts";

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
  ServicePolicy,
  ServicePolicyManifest,
  StackMode,
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

export { DEFAULT_MANAGED_STACK_NAME } from "./paths.ts";

export { NoRunningStackError } from "./managed/model.ts";

export type { PartialVersionManifest } from "./versions.ts";
export { PartialVersionManifestSchema } from "./versions.ts";
export { resolveConfig } from "./StackConfigResolver.ts";

export { DaemonStartError } from "./layers.ts";
export type { ManagedDaemonConfigInput } from "./layers.ts";
export type { StackSummary } from "./discovery.ts";
