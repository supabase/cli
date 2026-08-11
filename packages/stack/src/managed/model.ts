export const MANAGED_REGISTRY_SCHEMA_VERSION = 2;
export const ORDINARY_WORKSPACE_IDENTITY_VERSION = 1;
export const DEFAULT_MANAGED_STACK_NAME = "default";

export type ManagedRuntimeRequest = "auto" | "docker" | "native";
export type ManagedRuntime = "docker" | "native";
export type ManagedStackStatus = "active" | "pending" | "tombstoned";
export type ManagedStackLifecycle = "failed" | "running" | "starting" | "stopped" | "stopping";
export type ManagedPortIntent = "automatic" | "exact";
export type ManagedOperationKind = "delete" | "start" | "stop" | "update";
export type ManagedOperationStatus = "active" | "completed" | "failed";

export interface OrdinaryWorkspaceIdentity {
  readonly version: typeof ORDINARY_WORKSPACE_IDENTITY_VERSION;
  readonly projectId: string;
  readonly checkoutId: string;
  readonly contextId: string;
}

export interface ManagedStackPaths {
  readonly root: string;
  readonly data: string;
  readonly logs: string;
  readonly runtime: string;
}

export interface ManagedPortAssignment {
  readonly key: string;
  readonly port: number;
  readonly intent: ManagedPortIntent;
}

export interface ManagedRuntimeMetadata {
  readonly pid?: number;
  readonly socketPath?: string;
  readonly processIds: Readonly<Record<string, number>>;
  readonly containerIds: Readonly<Record<string, string>>;
}

export interface ManagedStackRecord {
  readonly id: string;
  readonly projectId: string;
  readonly checkoutId: string;
  readonly contextId: string;
  readonly name: string;
  readonly status: ManagedStackStatus;
  readonly lifecycle: ManagedStackLifecycle;
  readonly runtimeRequest: ManagedRuntimeRequest;
  readonly runtime?: ManagedRuntime;
  readonly paths: ManagedStackPaths;
  readonly ports: ReadonlyArray<ManagedPortAssignment>;
  readonly serviceVersions: Readonly<Record<string, string>>;
  readonly runtimeMetadata: ManagedRuntimeMetadata;
  readonly configFingerprint?: string;
  readonly credentialsReference?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly tombstonedAt?: string;
}

export interface ManagedOperationRecord {
  readonly token: string;
  readonly stackId: string;
  readonly kind: ManagedOperationKind;
  readonly status: ManagedOperationStatus;
  readonly ownerPid?: number;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly error?: string;
}

export interface ManagedCheckoutLocation {
  readonly id: string;
  readonly checkoutId: string;
  readonly canonicalPath: string;
  readonly lastSeenAt: string;
}

export interface ManagedStackConfiguration {
  readonly runtimeRequest?: ManagedRuntimeRequest;
  readonly runtime?: ManagedRuntime;
  readonly ports?: ReadonlyArray<ManagedPortAssignment>;
  readonly serviceVersions?: Readonly<Record<string, string>>;
  readonly runtimeMetadata?: ManagedRuntimeMetadata;
  readonly lifecycle?: ManagedStackLifecycle;
  readonly configFingerprint?: string;
  readonly credentialsReference?: string;
}

export interface ManagedStackSelection {
  readonly projectId: string;
  readonly checkoutId: string;
  readonly contextId: string;
  readonly stackId: string;
  readonly stackName: string;
}

export class ManagedStackError extends Error {}

export class InvalidManagedIdentityError extends ManagedStackError {
  readonly code = "INVALID_MANAGED_IDENTITY";

  constructor(message: string) {
    super(message);
    this.name = "InvalidManagedIdentityError";
  }
}

export class UnsupportedManagedRegistryVersionError extends ManagedStackError {
  readonly code = "UNSUPPORTED_MANAGED_REGISTRY_VERSION";

  constructor(
    readonly found: number,
    readonly supported: number,
  ) {
    super(`Managed registry version ${found} is unsupported; expected version ${supported}`);
    this.name = "UnsupportedManagedRegistryVersionError";
  }
}

export class DuplicateManagedIdentityError extends ManagedStackError {
  readonly code = "DUPLICATE_MANAGED_IDENTITY";

  constructor(
    readonly identityId: string,
    readonly existingClaim: string,
    readonly requestedClaim: string,
  ) {
    super(
      `Managed identity ${identityId} is already claimed by ${existingClaim}; refusing a second claim from ${requestedClaim}`,
    );
    this.name = "DuplicateManagedIdentityError";
  }
}

export class ManagedStackNotFoundError extends ManagedStackError {
  readonly code = "MANAGED_STACK_NOT_FOUND";

  constructor(readonly stackId: string) {
    super(`Managed stack ${stackId} was not found`);
    this.name = "ManagedStackNotFoundError";
  }
}

export class ManagedOperationInProgressError extends ManagedStackError {
  readonly code = "MANAGED_OPERATION_IN_PROGRESS";

  constructor(
    readonly stackId: string,
    readonly operation: ManagedOperationRecord,
  ) {
    super(`Managed stack ${stackId} already has an active ${operation.kind} operation`);
    this.name = "ManagedOperationInProgressError";
  }
}

export class ManagedOperationOwnershipError extends ManagedStackError {
  readonly code = "MANAGED_OPERATION_OWNERSHIP_MISMATCH";

  constructor(readonly stackId: string) {
    super(`The active operation for managed stack ${stackId} is owned by another caller`);
    this.name = "ManagedOperationOwnershipError";
  }
}

export class ManagedPortReservationError extends ManagedStackError {
  readonly code = "MANAGED_PORT_ALREADY_RESERVED";

  constructor(
    readonly port: number,
    readonly ownerStackId: string,
  ) {
    super(`Port ${port} is already reserved by managed stack ${ownerStackId}`);
    this.name = "ManagedPortReservationError";
  }
}

export class ManagedRunningStackPortChangeError extends ManagedStackError {
  readonly code = "MANAGED_RUNNING_STACK_PORT_CHANGE";

  constructor(readonly stackId: string) {
    super(`Managed stack ${stackId} cannot change ports while it continues to occupy them`);
    this.name = "ManagedRunningStackPortChangeError";
  }
}

export class UnsafeManagedStackPathError extends ManagedStackError {
  readonly code = "UNSAFE_MANAGED_STACK_PATH";

  constructor(readonly path: string) {
    super(`Refusing to remove an unsafe managed stack path: ${path}`);
    this.name = "UnsafeManagedStackPathError";
  }
}

export class ManagedStackInitializationError extends ManagedStackError {
  readonly code = "MANAGED_STACK_INITIALIZATION_FAILED";

  constructor(
    readonly stackId: string,
    override readonly cause: unknown,
    readonly cleanupErrors: ReadonlyArray<unknown> = [],
  ) {
    super(`Managed stack ${stackId} could not be initialized`);
    this.name = "ManagedStackInitializationError";
  }
}

export class ManagedStackPublicationTimeoutError extends ManagedStackError {
  readonly code = "MANAGED_STACK_PUBLICATION_TIMEOUT";

  constructor(readonly stackId: string) {
    super(`Timed out waiting for managed stack ${stackId} to be published`);
    this.name = "ManagedStackPublicationTimeoutError";
  }
}

export class ManagedAbandonedOperationError extends ManagedStackError {
  readonly code = "MANAGED_OPERATION_REQUIRES_RECONCILIATION";

  constructor(readonly stackId: string) {
    super(`Managed stack ${stackId} has an abandoned operation that must be reconciled`);
    this.name = "ManagedAbandonedOperationError";
  }
}
