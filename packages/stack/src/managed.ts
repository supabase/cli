export {
  GIT_PROJECT_ID_KEY,
  GitConfigStore,
  ensureBranchContextId,
  ensureGitCheckoutIdentity,
  gitBranchContextIdKey,
  inspectWorkspace,
  readBranchContextId,
  readGitCheckoutIdentity,
  gitConfigStoreLayer,
} from "./managed/git.ts";
export type {
  GitCheckoutIdentityState,
  GitCheckoutInspection,
  GitCheckoutKind,
  GitConfigStoreShape,
  GitHead,
  OrdinaryFolderInspection,
  WorkspaceInspection,
  EnsureGitCheckoutIdentityResult,
} from "./managed/git.ts";
export {
  ensureOrdinaryWorkspaceIdentity,
  readOrdinaryWorkspaceIdentity,
} from "./managed/identity.ts";
export type { EnsureOrdinaryWorkspaceIdentityResult } from "./managed/identity.ts";
export * from "./managed/ids.ts";
export {
  acquireControl,
  controlEndpoint,
  controlEndpointPath,
  ControlAddressConflictError,
  ControlBindError,
  ControlProtocolError,
  ControlProtocolMismatchError,
  ControlTransportError,
  InvalidControlOwnershipIdError,
} from "./managed/control.ts";
export type {
  ControlAcquisition,
  ControlAttached,
  ControlEndpoint,
  ControlOwnerState,
  ControlOwnerStatus,
  ControlOwnership,
  ControlOwnershipInput,
} from "./managed/control.ts";
export * from "./managed/model.ts";
export * from "./managed/paths.ts";
export {
  ManagedPortCoordinator,
  type ManagedPortCoordinatorOptions,
  type ManagedPortCoordinatorShape,
  type ManagedPortStartAllocation,
  type ManagedPortStartFailure,
} from "./managed/port-coordinator.ts";
export * from "./managed/service.ts";
export type {
  ManagedBranchOwnerEvidence,
  ManagedFolderToGitClaim,
  ManagedHistoricalPathEvidence,
  ManagedHistoricalPathProbe,
  ManagedOrdinaryMarkerEvidence,
  ManagedRecoveryOperation,
  ManagedWorkspaceDiscovery,
  ManagedWorkspaceDiscoveryContext,
  ManagedWorkspaceDiscoveryIdentity,
  ManagedWorkspaceDiscoveryState,
  ManagedWorkspaceDiscoveryWorkspace,
} from "./managed/discovery.ts";
// Only the repository contract is public. The port-ownership and update-guard
// helpers behind it are invariants the adapters share with each other, not API
// consumers can call meaningfully, and the in-memory adapter is a test seam
// exported through `@supabase/stack/testing` instead.
export { ManagedStackRepository } from "./managed/repository.ts";
export type {
  ClaimManagedOperationFailure,
  ClaimManagedOperationInput,
  ClaimManagedOperationResult,
  ManagedStackRepositoryShape,
  AbandonManagedIdentityTransitionInput,
  AbandonManagedIdentityTransitionResult,
  ManagedIdentityRecoveryError,
  OwnedManagedStackFailure,
  PrepareStackFailure,
  PrepareStackInput,
  PrepareStackResult,
  ReconcileManagedOperationFailure,
  ReconcileManagedOperationResult,
  PruneManagedIdentityMetadataInput,
  PruneManagedIdentityMetadataResult,
  UpdateManagedStackFailure,
  UpdateManagedStackInput,
} from "./managed/repository.ts";
export type {
  CreateManagedStackServiceOptions,
  MakeManagedStackServiceOptions,
  ManagedStackLayerFailure,
  ManagedStackServiceHandle,
  ReconcileAbandonedOperationsRequest,
  ResolveManagedStackRequest,
} from "./managed/create-service.ts";
export type {
  ManagedPruneFailure,
  ManagedPruneRequest,
  ManagedPruneResult,
  ManagedIdentityTransitionAbandonRequest,
} from "./managed/service.ts";

// Lean document-store manager. The store and repository adapters remain
// internal implementation details; only the manager capability is exported.
export {
  ManagedStackManager,
  managedStackManagerLayer,
  makeManagedStackManager,
  createManagedStackManager,
  deriveRepairOwnershipId,
  ManagedStackControlRequiredError,
  ManagedStackAttachedError,
  ManagedWorkspaceRepairConflictError,
} from "./managed/manager.ts";
export type {
  ManagedStack,
  ManagedStackManagerShape,
  ManagedStackManagerError,
  ManagedStackManagerHandle,
  ManagedStackStartResult,
  ManagedStackLifecycleUpdate,
  ManagedPortLease,
  ManagedPortAllocation,
  ManagedDeleteResult,
  AllocateManagedPortsRequest,
  ResolveStackRequest,
  ResolveStackStartRequest,
  ResolveStackStatusRequest,
} from "./managed/manager.ts";
