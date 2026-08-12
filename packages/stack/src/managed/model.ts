export const MANAGED_REGISTRY_SCHEMA_VERSION = 3;
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

export class InvalidManagedStackNameError extends ManagedStackError {
  readonly code = "MANAGED_INVALID_STACK_NAME";

  constructor(readonly stackName: string) {
    super(`Invalid managed stack name: ${stackName}`);
    this.name = "InvalidManagedStackNameError";
  }
}

export class InvalidManagedOwnerPidError extends ManagedStackError {
  readonly code = "MANAGED_INVALID_OWNER_PID";

  constructor(readonly ownerPid: number) {
    super(`Invalid managed operation owner pid ${ownerPid}`);
    this.name = "InvalidManagedOwnerPidError";
  }
}

export class InvalidManagedPortError extends ManagedStackError {
  readonly code = "MANAGED_INVALID_PORT";

  constructor(
    readonly port: number,
    readonly key: string,
  ) {
    super(`Invalid managed port ${port} for ${key}`);
    this.name = "InvalidManagedPortError";
  }
}

export class ManagedStackNotFoundError extends ManagedStackError {
  readonly code = "MANAGED_STACK_NOT_FOUND";

  constructor(readonly stackId: string) {
    super(`Managed stack ${stackId} was not found`);
    this.name = "ManagedStackNotFoundError";
  }
}

export class ManagedStackNotStoppedError extends ManagedStackError {
  readonly code = "MANAGED_STACK_NOT_STOPPED";

  constructor(readonly stackId: string) {
    super(`Managed stack ${stackId} must be safely stopped before deletion`);
    this.name = "ManagedStackNotStoppedError";
  }
}

export class ManagedPendingStackUpdateError extends ManagedStackError {
  readonly code = "MANAGED_PENDING_STACK_UPDATE";

  constructor(readonly stackId: string) {
    super(
      `Managed stack ${stackId} is still pending publication and cannot be reconfigured through an update`,
    );
    this.name = "ManagedPendingStackUpdateError";
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

  /**
   * The refused path is quoted rather than interpolated bare: the values worth
   * refusing include blank and whitespace-only ones, which would otherwise
   * render as an empty message tail. `reason` names which refusal this is,
   * since the same coded failure guards both stack removal and state roots.
   */
  constructor(
    readonly path: string,
    reason = "Refusing to remove an unsafe managed stack path",
  ) {
    super(`${reason}: ${JSON.stringify(path)}`);
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

/**
 * Every `code` literal declared by a {@link ManagedStackError} subclass.
 *
 * Managed failures are plain `Error` subclasses: none carries a `_tag`, and
 * identifier minification renames the constructors, so `code` is the only
 * discriminator consumers can dispatch on. This list is the machine-readable
 * form of that contract. `managed-model.unit.test.ts` keeps it exhaustive
 * against the exported classes, and the CLI's telemetry classifier types its
 * dispatch table as `Record<ManagedErrorCode, ...>` so a new code cannot be
 * added here without classifying it there.
 *
 * This module must stay free of runtime-specific imports: it is published as
 * `@supabase/stack/managed-model` precisely so consumers can import the codes
 * under Bun and Node alike, without pulling in a SQLite driver.
 */
export const MANAGED_ERROR_CODES = [
  "DUPLICATE_MANAGED_IDENTITY",
  "INVALID_MANAGED_IDENTITY",
  "MANAGED_INVALID_OWNER_PID",
  "MANAGED_INVALID_PORT",
  "MANAGED_INVALID_STACK_NAME",
  "MANAGED_OPERATION_IN_PROGRESS",
  "MANAGED_OPERATION_OWNERSHIP_MISMATCH",
  "MANAGED_OPERATION_REQUIRES_RECONCILIATION",
  "MANAGED_PENDING_STACK_UPDATE",
  "MANAGED_PORT_ALREADY_RESERVED",
  "MANAGED_RUNNING_STACK_PORT_CHANGE",
  "MANAGED_STACK_INITIALIZATION_FAILED",
  "MANAGED_STACK_NOT_FOUND",
  "MANAGED_STACK_NOT_STOPPED",
  "MANAGED_STACK_PUBLICATION_TIMEOUT",
  "UNSAFE_MANAGED_STACK_PATH",
  "UNSUPPORTED_MANAGED_REGISTRY_VERSION",
] as const;

export type ManagedErrorCode = (typeof MANAGED_ERROR_CODES)[number];
