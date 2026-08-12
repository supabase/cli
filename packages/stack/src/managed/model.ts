import { Data } from "effect";

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

export class InvalidManagedIdentityError extends Data.TaggedError("InvalidManagedIdentityError")<{
  readonly message: string;
}> {
  readonly code = "INVALID_MANAGED_IDENTITY" as const;
}

export class UnsupportedManagedRegistryVersionError extends Data.TaggedError(
  "UnsupportedManagedRegistryVersionError",
)<{
  readonly found: number;
  readonly supported: number;
}> {
  readonly code = "UNSUPPORTED_MANAGED_REGISTRY_VERSION" as const;

  override get message(): string {
    return `Managed registry version ${this.found} is unsupported; expected version ${this.supported}`;
  }
}

export class DuplicateManagedIdentityError extends Data.TaggedError(
  "DuplicateManagedIdentityError",
)<{
  readonly identityId: string;
  readonly existingClaim: string;
  readonly requestedClaim: string;
}> {
  readonly code = "DUPLICATE_MANAGED_IDENTITY" as const;

  override get message(): string {
    return `Managed identity ${this.identityId} is already claimed by ${this.existingClaim}; refusing a second claim from ${this.requestedClaim}`;
  }
}

export class InvalidManagedStackNameError extends Data.TaggedError("InvalidManagedStackNameError")<{
  readonly stackName: string;
}> {
  readonly code = "MANAGED_INVALID_STACK_NAME" as const;

  override get message(): string {
    return `Invalid managed stack name: ${this.stackName}`;
  }
}

export class InvalidManagedOwnerPidError extends Data.TaggedError("InvalidManagedOwnerPidError")<{
  readonly ownerPid: number;
}> {
  readonly code = "MANAGED_INVALID_OWNER_PID" as const;

  override get message(): string {
    return `Invalid managed operation owner pid ${this.ownerPid}`;
  }
}

export class InvalidManagedPortError extends Data.TaggedError("InvalidManagedPortError")<{
  readonly port: number;
  readonly key: string;
}> {
  readonly code = "MANAGED_INVALID_PORT" as const;

  override get message(): string {
    return `Invalid managed port ${this.port} for ${this.key}`;
  }
}

export class ManagedStackNotFoundError extends Data.TaggedError("ManagedStackNotFoundError")<{
  readonly stackId: string;
}> {
  readonly code = "MANAGED_STACK_NOT_FOUND" as const;

  override get message(): string {
    return `Managed stack ${this.stackId} was not found`;
  }
}

export class ManagedStackNotStoppedError extends Data.TaggedError("ManagedStackNotStoppedError")<{
  readonly stackId: string;
}> {
  readonly code = "MANAGED_STACK_NOT_STOPPED" as const;

  override get message(): string {
    return `Managed stack ${this.stackId} must be safely stopped before deletion`;
  }
}

export class ManagedPendingStackUpdateError extends Data.TaggedError(
  "ManagedPendingStackUpdateError",
)<{
  readonly stackId: string;
}> {
  readonly code = "MANAGED_PENDING_STACK_UPDATE" as const;

  override get message(): string {
    return `Managed stack ${this.stackId} is still pending publication and cannot be reconfigured through an update`;
  }
}

export class ManagedOperationInProgressError extends Data.TaggedError(
  "ManagedOperationInProgressError",
)<{
  readonly stackId: string;
  readonly operation: ManagedOperationRecord;
}> {
  readonly code = "MANAGED_OPERATION_IN_PROGRESS" as const;

  override get message(): string {
    return `Managed stack ${this.stackId} already has an active ${this.operation.kind} operation`;
  }
}

export class ManagedOperationOwnershipError extends Data.TaggedError(
  "ManagedOperationOwnershipError",
)<{
  readonly stackId: string;
}> {
  readonly code = "MANAGED_OPERATION_OWNERSHIP_MISMATCH" as const;

  override get message(): string {
    return `The active operation for managed stack ${this.stackId} is owned by another caller`;
  }
}

export class ManagedPortReservationError extends Data.TaggedError("ManagedPortReservationError")<{
  readonly port: number;
  readonly ownerStackId: string;
}> {
  readonly code = "MANAGED_PORT_ALREADY_RESERVED" as const;

  override get message(): string {
    return `Port ${this.port} is already reserved by managed stack ${this.ownerStackId}`;
  }
}

export class ManagedRunningStackPortChangeError extends Data.TaggedError(
  "ManagedRunningStackPortChangeError",
)<{
  readonly stackId: string;
}> {
  readonly code = "MANAGED_RUNNING_STACK_PORT_CHANGE" as const;

  override get message(): string {
    return `Managed stack ${this.stackId} cannot change ports while it continues to occupy them`;
  }
}

/**
 * The default `reason` prefix, used by the stack-removal guard that motivated
 * this failure. State-root refusals pass their own `reason`.
 */
const UNSAFE_MANAGED_STACK_PATH_REASON = "Refusing to remove an unsafe managed stack path";

export class UnsafeManagedStackPathError extends Data.TaggedError("UnsafeManagedStackPathError")<{
  readonly path: string;
  /**
   * Names which refusal this is, since the same coded failure guards both
   * stack removal and state roots. Defaults to the stack-removal wording.
   */
  readonly reason?: string;
}> {
  readonly code = "UNSAFE_MANAGED_STACK_PATH" as const;

  /**
   * The refused path is quoted rather than interpolated bare: the values worth
   * refusing include blank and whitespace-only ones, which would otherwise
   * render as an empty message tail.
   */
  override get message(): string {
    return `${this.reason ?? UNSAFE_MANAGED_STACK_PATH_REASON}: ${JSON.stringify(this.path)}`;
  }
}

export class ManagedStackInitializationError extends Data.TaggedError(
  "ManagedStackInitializationError",
)<{
  readonly stackId: string;
  readonly cause: unknown;
  readonly cleanupErrors: ReadonlyArray<unknown>;
}> {
  readonly code = "MANAGED_STACK_INITIALIZATION_FAILED" as const;

  override get message(): string {
    return `Managed stack ${this.stackId} could not be initialized`;
  }
}

export class ManagedStackPublicationTimeoutError extends Data.TaggedError(
  "ManagedStackPublicationTimeoutError",
)<{
  readonly stackId: string;
}> {
  readonly code = "MANAGED_STACK_PUBLICATION_TIMEOUT" as const;

  override get message(): string {
    return `Timed out waiting for managed stack ${this.stackId} to be published`;
  }
}

export class ManagedAbandonedOperationError extends Data.TaggedError(
  "ManagedAbandonedOperationError",
)<{
  readonly stackId: string;
}> {
  readonly code = "MANAGED_OPERATION_REQUIRES_RECONCILIATION" as const;

  override get message(): string {
    return `Managed stack ${this.stackId} has an abandoned operation that must be reconciled`;
  }
}

/**
 * Any managed registry failure.
 *
 * Every managed failure is a `Data.TaggedError`, so they cannot share a base
 * class — each one extends its own generated base. The hierarchy is therefore a
 * union type rather than a root class, and {@link isManagedStackError} is the
 * runtime equivalent of the old `instanceof` check.
 */
export type ManagedStackError =
  | DuplicateManagedIdentityError
  | InvalidManagedIdentityError
  | InvalidManagedOwnerPidError
  | InvalidManagedPortError
  | InvalidManagedStackNameError
  | ManagedAbandonedOperationError
  | ManagedOperationInProgressError
  | ManagedOperationOwnershipError
  | ManagedPendingStackUpdateError
  | ManagedPortReservationError
  | ManagedRunningStackPortChangeError
  | ManagedStackInitializationError
  | ManagedStackNotFoundError
  | ManagedStackNotStoppedError
  | ManagedStackPublicationTimeoutError
  | UnsafeManagedStackPathError
  | UnsupportedManagedRegistryVersionError;

/**
 * Every `code` literal declared by a managed failure.
 *
 * `code` is the wire-level contract: identifier minification renames the
 * constructors, so a release build's telemetry and any cross-runtime consumer
 * need a value the bundler cannot touch. `managed-model.unit.test.ts` keeps
 * this list exhaustive against the exported classes, and the CLI's telemetry
 * classifier types its dispatch table as `Record<ManagedErrorCode, ...>` so a
 * new code cannot be added here without classifying it there.
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

/**
 * The single source of truth linking each managed `code` to the `_tag` of the
 * class that declares it.
 *
 * `_tag` is the Effect-native discriminant (`Effect.catchTag`, structural
 * dispatch) and `code` is the stable wire-level contract. Consumers that key a
 * table by one and dispatch on the other — the CLI's telemetry classifier is
 * the motivating case — derive it from this map instead of restating all
 * seventeen pairs by hand.
 */
export const MANAGED_ERROR_TAG_BY_CODE = {
  DUPLICATE_MANAGED_IDENTITY: "DuplicateManagedIdentityError",
  INVALID_MANAGED_IDENTITY: "InvalidManagedIdentityError",
  MANAGED_INVALID_OWNER_PID: "InvalidManagedOwnerPidError",
  MANAGED_INVALID_PORT: "InvalidManagedPortError",
  MANAGED_INVALID_STACK_NAME: "InvalidManagedStackNameError",
  MANAGED_OPERATION_IN_PROGRESS: "ManagedOperationInProgressError",
  MANAGED_OPERATION_OWNERSHIP_MISMATCH: "ManagedOperationOwnershipError",
  MANAGED_OPERATION_REQUIRES_RECONCILIATION: "ManagedAbandonedOperationError",
  MANAGED_PENDING_STACK_UPDATE: "ManagedPendingStackUpdateError",
  MANAGED_PORT_ALREADY_RESERVED: "ManagedPortReservationError",
  MANAGED_RUNNING_STACK_PORT_CHANGE: "ManagedRunningStackPortChangeError",
  MANAGED_STACK_INITIALIZATION_FAILED: "ManagedStackInitializationError",
  MANAGED_STACK_NOT_FOUND: "ManagedStackNotFoundError",
  MANAGED_STACK_NOT_STOPPED: "ManagedStackNotStoppedError",
  MANAGED_STACK_PUBLICATION_TIMEOUT: "ManagedStackPublicationTimeoutError",
  UNSAFE_MANAGED_STACK_PATH: "UnsafeManagedStackPathError",
  UNSUPPORTED_MANAGED_REGISTRY_VERSION: "UnsupportedManagedRegistryVersionError",
} as const satisfies Record<ManagedErrorCode, ManagedStackError["_tag"]>;

const MANAGED_ERROR_TAGS: ReadonlySet<string> = new Set(Object.values(MANAGED_ERROR_TAG_BY_CODE));

/**
 * Whether a value is a managed registry failure. Replaces the `instanceof`
 * check against the removed `ManagedStackError` root class: the union's members
 * each extend their own `Data.TaggedError` base, so the shared discriminator is
 * the tag rather than a prototype chain.
 */
export function isManagedStackError(error: unknown): error is ManagedStackError {
  if (!(error instanceof Error) || !("_tag" in error)) return false;
  const tag: unknown = error._tag;
  return typeof tag === "string" && MANAGED_ERROR_TAGS.has(tag);
}
