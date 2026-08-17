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
export * from "./managed/environment.ts";
export {
  acquireControl,
  controlEndpoint,
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
  ManagedStackAllocationHandle,
  ManagedPortAllocation,
  ManagedDeleteResult,
  AllocateManagedPortsRequest,
  ReadStackRequest,
  StartStackRequest,
  ManagedStackLaunchUpdate,
} from "./managed/manager.ts";
export {
  connectManagedStack,
  deleteManagedStack,
  resolveManagedDocument,
  stopManagedStack,
  updateManagedLaunch,
} from "./managed/lifecycle.ts";
export type { ManagedLifecycleInput } from "./managed/lifecycle.ts";
