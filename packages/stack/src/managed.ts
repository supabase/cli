export * from "./managed/identity.ts";
export * from "./managed/ids.ts";
export * from "./managed/model.ts";
export * from "./managed/paths.ts";
export * from "./managed/service.ts";
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
  OwnedManagedStackFailure,
  PrepareOrdinaryStackFailure,
  PrepareOrdinaryStackInput,
  PrepareOrdinaryStackResult,
  ReconcileManagedOperationFailure,
  ReconcileManagedOperationResult,
  UpdateManagedStackFailure,
  UpdateManagedStackInput,
} from "./managed/repository.ts";
export type {
  CreateManagedStackServiceOptions,
  MakeManagedStackServiceOptions,
  ManagedStackLayerFailure,
  ManagedStackServiceHandle,
  ProvisionOrdinaryStackRequest,
  ReconcileAbandonedOperationsRequest,
} from "./managed/create-service.ts";
