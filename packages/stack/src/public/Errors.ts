import { Data, Predicate } from "effect";
import type { StackId } from "./StackId.ts";
import type { ContainerEngineKind } from "../runtime/ContainerEngine.ts";
import type { ServiceStatus, StackRecovery } from "./Status.ts";

/** Common context present on every public stack error. */
interface ErrorFields {
  readonly message: string;
  readonly cause?: unknown;
}

/** Durable result details for a partial lifecycle batch. */
export interface LifecycleOutcome {
  readonly requested: ReadonlyArray<string>;
  readonly affected: ReadonlyArray<string>;
  readonly succeeded: ReadonlyArray<string>;
  readonly failed: ReadonlyArray<string>;
  readonly statuses?: ReadonlyArray<ServiceStatus>;
  readonly recovery?: StackRecovery;
  readonly removed?: ReadonlyArray<string>;
  readonly retained?: ReadonlyArray<string>;
}

export interface IdentityErrorFields extends ErrorFields {
  readonly path?: string;
  readonly reason?: string;
  readonly stackId?: StackId;
  readonly name?: string;
}

export interface ProjectRootErrorFields extends ErrorFields {
  readonly projectRoot?: string;
  readonly stateRoot?: string;
}

export interface ConfigErrorFields extends ErrorFields {
  readonly stackId?: StackId;
  readonly capability?: string;
  readonly dependency?: string;
  readonly version?: string;
  readonly workload?: string;
  readonly functionsRoot?: string;
  readonly setting?: string;
  readonly function?: string;
  readonly environment?: string;
  readonly provider?: string;
  readonly target?: string;
}

export class InvalidStackIdentityError extends Data.TaggedError(
  "InvalidStackIdentityError",
)<IdentityErrorFields> {}
export class InvalidProjectRootError extends Data.TaggedError(
  "InvalidProjectRootError",
)<ProjectRootErrorFields> {}
export class InvalidStackConfigError extends Data.TaggedError(
  "InvalidStackConfigError",
)<ConfigErrorFields> {}
export class StackVersionUnsupportedError extends Data.TaggedError(
  "StackVersionUnsupportedError",
)<ConfigErrorFields> {}

export class StackNotFoundError extends Data.TaggedError("StackNotFoundError")<
  ErrorFields & { readonly stackId?: StackId }
> {}
export class StackOwnershipConflictError extends Data.TaggedError("StackOwnershipConflictError")<
  ErrorFields & { readonly stackId?: StackId }
> {}
export class UncertainOperationError extends Data.TaggedError("UncertainOperationError")<
  ErrorFields & {
    readonly stackId: StackId;
    readonly instanceId?: string;
    readonly operationId?: string;
    /** Creation requests use this pre-dispatch digest for safe reconciliation. */
    readonly expectedCreationInputsId?: string;
    readonly mutation:
      | "create"
      | "restore"
      | "start"
      | "sleep"
      | "stop"
      | "restart"
      | "destroy"
      | "exportSnapshot";
  }
> {}
export class OwnerRetiringError extends Data.TaggedError("OwnerRetiringError")<
  ErrorFields & { readonly stackId: StackId; readonly ownerSessionId: string }
> {}
export class StackRuntimeMismatchError extends Data.TaggedError(
  "StackRuntimeMismatchError",
)<ErrorFields> {}

export class StackNotRunningError extends Data.TaggedError("StackNotRunningError")<
  ErrorFields & { readonly stackId?: StackId }
> {}
export class StackMustBeStoppedError extends Data.TaggedError("StackMustBeStoppedError")<
  ErrorFields & { readonly slot?: string; readonly stackId?: StackId; readonly guidance?: string }
> {}
export class StackLifecycleConflictError extends Data.TaggedError("StackLifecycleConflictError")<
  ErrorFields & {
    readonly stackId?: StackId;
    readonly instanceId?: string;
    readonly recovery?: StackRecovery;
    readonly outcome?: LifecycleOutcome;
  }
> {}
export class ServiceNotFoundError extends Data.TaggedError("ServiceNotFoundError")<
  ErrorFields & { readonly instanceId?: string }
> {}
export class ServiceNameConflictError extends Data.TaggedError("ServiceNameConflictError")<
  ErrorFields & { readonly name?: string }
> {}
export class ServiceDependencyError extends Data.TaggedError("ServiceDependencyError")<
  ErrorFields & { readonly service?: string; readonly dependency?: string }
> {}
export class InitializationMismatchError extends Data.TaggedError("InitializationMismatchError")<
  ErrorFields & { readonly instanceId?: string; readonly profileId?: string }
> {}
export class UnsupportedSnapshotError extends Data.TaggedError("UnsupportedSnapshotError")<
  ErrorFields & { readonly instanceId?: string; readonly service?: string }
> {}
export class NoSnapshotDataError extends Data.TaggedError("NoSnapshotDataError")<
  ErrorFields & { readonly instanceId?: string }
> {}
export class SnapshotTargetInvalidError extends Data.TaggedError("SnapshotTargetInvalidError")<
  ErrorFields & { readonly path?: string }
> {}

export class StackStateInvalidError extends Data.TaggedError("StackStateInvalidError")<
  ErrorFields & {
    readonly stackId?: StackId;
    readonly path?: string;
    readonly code?: string;
    readonly slot?: string;
  }
> {}
export class InvalidLogCursorError extends Data.TaggedError("InvalidLogCursorError")<ErrorFields> {}
export class StackStateFormatUnsupportedError extends Data.TaggedError(
  "StackStateFormatUnsupportedError",
)<ErrorFields & { readonly format?: string }> {}
export class StackUpgradeRequiredError extends Data.TaggedError("StackUpgradeRequiredError")<
  ErrorFields & { readonly expectedRelease?: string; readonly actualRelease?: string }
> {}
export class StackSecretMismatchError extends Data.TaggedError("StackSecretMismatchError")<
  ErrorFields & { readonly slot?: string }
> {}
export class InvalidJwtSigningMaterialError extends Data.TaggedError(
  "InvalidJwtSigningMaterialError",
)<ErrorFields & { readonly path?: string }> {}

export class PortAllocationError extends Data.TaggedError("PortAllocationError")<
  ErrorFields & { readonly port?: number; readonly field?: string }
> {}
export class PortUnavailableError extends Data.TaggedError("PortUnavailableError")<
  ErrorFields & {
    readonly port?: number;
    readonly field?: string;
    readonly address?: string;
  }
> {}

export class GatewayActivationError extends Data.TaggedError("GatewayActivationError")<
  ErrorFields & {
    readonly capability?: string;
    readonly workload?: string;
    readonly recovery?: StackRecovery;
  }
> {}

export class StackPreparationError extends Data.TaggedError("StackPreparationError")<
  ConfigErrorFields & {
    readonly path?: string;
    readonly field?: string;
    readonly value?: unknown;
    readonly service?: string;
    readonly platform?: string;
    readonly image?: string;
    readonly key?: string;
    readonly name?: string;
  }
> {}
export class ArtifactIntegrityError extends Data.TaggedError("ArtifactIntegrityError")<
  ErrorFields & {
    readonly expected?: string;
    readonly actual?: string;
    readonly path?: string;
    readonly key?: string;
  }
> {}
export class ContainerPullError extends Data.TaggedError("ContainerPullError")<
  ErrorFields & { readonly workload?: string; readonly image?: string }
> {}

export class StackRuntimeError extends Data.TaggedError("StackRuntimeError")<
  ErrorFields & { readonly stackId?: StackId; readonly workloadId?: string }
> {}
export class StackCleanupError extends Data.TaggedError("StackCleanupError")<ErrorFields> {}
export class ContainerEngineError extends Data.TaggedError("ContainerEngineError")<
  ErrorFields & { readonly engine?: ContainerEngineKind }
> {}
export class StackDestructionError extends Data.TaggedError("StackDestructionError")<
  ErrorFields & { readonly outcome?: LifecycleOutcome }
> {}
export class PostgresClientError extends Data.TaggedError("PostgresClientError")<
  ErrorFields & {
    readonly reason?: "missing-bin" | "spawn";
    readonly bin?: string;
    readonly engine?: ContainerEngineKind;
  }
> {}

/** Stable wire tags for errors produced by the managed stack runtime. */
export const STACK_ERROR_TAGS = [
  "InvalidStackIdentityError",
  "InvalidProjectRootError",
  "InvalidStackConfigError",
  "StackVersionUnsupportedError",
  "StackNotFoundError",
  "StackOwnershipConflictError",
  "UncertainOperationError",
  "OwnerRetiringError",
  "StackRuntimeMismatchError",
  "StackNotRunningError",
  "StackMustBeStoppedError",
  "StackLifecycleConflictError",
  "ServiceNotFoundError",
  "ServiceNameConflictError",
  "ServiceDependencyError",
  "InitializationMismatchError",
  "UnsupportedSnapshotError",
  "NoSnapshotDataError",
  "SnapshotTargetInvalidError",
  "StackStateInvalidError",
  "InvalidLogCursorError",
  "StackStateFormatUnsupportedError",
  "StackUpgradeRequiredError",
  "StackSecretMismatchError",
  "InvalidJwtSigningMaterialError",
  "PortAllocationError",
  "PortUnavailableError",
  "GatewayActivationError",
  "StackPreparationError",
  "ArtifactIntegrityError",
  "ContainerPullError",
  "StackRuntimeError",
  "StackCleanupError",
  "ContainerEngineError",
  "StackDestructionError",
  "PostgresClientError",
] as const;

export type StackErrorTag = (typeof STACK_ERROR_TAGS)[number];

export const isStackErrorTag = (tag: string): tag is StackErrorTag =>
  STACK_ERROR_TAGS.some((candidate) => candidate === tag);

export type StackError =
  | InvalidStackIdentityError
  | InvalidProjectRootError
  | InvalidStackConfigError
  | StackVersionUnsupportedError
  | StackNotFoundError
  | StackOwnershipConflictError
  | UncertainOperationError
  | OwnerRetiringError
  | StackRuntimeMismatchError
  | StackNotRunningError
  | StackMustBeStoppedError
  | StackLifecycleConflictError
  | ServiceNotFoundError
  | ServiceNameConflictError
  | ServiceDependencyError
  | InitializationMismatchError
  | UnsupportedSnapshotError
  | NoSnapshotDataError
  | SnapshotTargetInvalidError
  | StackStateInvalidError
  | InvalidLogCursorError
  | StackStateFormatUnsupportedError
  | StackUpgradeRequiredError
  | StackSecretMismatchError
  | InvalidJwtSigningMaterialError
  | PortAllocationError
  | PortUnavailableError
  | GatewayActivationError
  | StackPreparationError
  | ArtifactIntegrityError
  | ContainerPullError
  | StackRuntimeError
  | StackCleanupError
  | ContainerEngineError
  | StackDestructionError
  | PostgresClientError;

export const isStackError = (value: unknown): value is StackError =>
  Predicate.hasProperty(value, "_tag") &&
  typeof value._tag === "string" &&
  isStackErrorTag(value._tag);

type ErrorByTag<Tag extends StackErrorTag> = Extract<StackError, { _tag: Tag }>;

export const CREATE_STACK_ERROR_TAGS = [
  "InvalidStackIdentityError",
  "InvalidProjectRootError",
  "StackOwnershipConflictError",
  "OwnerRetiringError",
  "StackRuntimeMismatchError",
  "ContainerEngineError",
  "StackRuntimeError",
  "StackStateInvalidError",
  "StackStateFormatUnsupportedError",
] as const satisfies ReadonlyArray<StackErrorTag>;
export type CreateStackError = ErrorByTag<(typeof CREATE_STACK_ERROR_TAGS)[number]>;

export const OPEN_STACK_ERROR_TAGS = [
  "StackNotFoundError",
  "StackOwnershipConflictError",
  "OwnerRetiringError",
  "StackRuntimeMismatchError",
  "InvalidProjectRootError",
  "StackStateInvalidError",
  "StackStateFormatUnsupportedError",
  "StackUpgradeRequiredError",
] as const satisfies ReadonlyArray<StackErrorTag>;
export type OpenStackError = ErrorByTag<(typeof OPEN_STACK_ERROR_TAGS)[number]>;

export const STACK_DISCOVERY_ERROR_TAGS = [
  "InvalidStackIdentityError",
  "InvalidProjectRootError",
  "StackStateInvalidError",
  "StackStateFormatUnsupportedError",
] as const satisfies ReadonlyArray<StackErrorTag>;
export type StackDiscoveryError = ErrorByTag<(typeof STACK_DISCOVERY_ERROR_TAGS)[number]>;

export const STACK_STATUS_ERROR_TAGS = [
  "StackNotFoundError",
  "StackOwnershipConflictError",
  "OwnerRetiringError",
  "StackLifecycleConflictError",
  "StackStateInvalidError",
  "StackStateFormatUnsupportedError",
  "StackUpgradeRequiredError",
] as const satisfies ReadonlyArray<StackErrorTag>;
export type StackStatusError = ErrorByTag<(typeof STACK_STATUS_ERROR_TAGS)[number]>;

export const STACK_CREDENTIALS_ERROR_TAGS = [
  "InvalidStackConfigError",
  "StackNotFoundError",
  "StackNotRunningError",
  "StackOwnershipConflictError",
  "OwnerRetiringError",
  "StackLifecycleConflictError",
  "StackSecretMismatchError",
  "InvalidJwtSigningMaterialError",
  "StackUpgradeRequiredError",
] as const satisfies ReadonlyArray<StackErrorTag>;
export type StackCredentialsError = ErrorByTag<(typeof STACK_CREDENTIALS_ERROR_TAGS)[number]>;

export const PREPARE_STACK_ERROR_TAGS = [
  "InvalidStackConfigError",
  "StackVersionUnsupportedError",
  "InvalidProjectRootError",
  "StackPreparationError",
  "ArtifactIntegrityError",
  "ContainerPullError",
  "ContainerEngineError",
  "StackStateInvalidError",
  "StackStateFormatUnsupportedError",
] as const satisfies ReadonlyArray<StackErrorTag>;
export type PrepareStackError = ErrorByTag<(typeof PREPARE_STACK_ERROR_TAGS)[number]>;

export const STACK_START_ERROR_TAGS = [
  "InvalidStackConfigError",
  "StackVersionUnsupportedError",
  "StackOwnershipConflictError",
  "OwnerRetiringError",
  "StackNotRunningError",
  "StackMustBeStoppedError",
  "StackLifecycleConflictError",
  "StackStateInvalidError",
  "StackStateFormatUnsupportedError",
  "StackUpgradeRequiredError",
  "StackSecretMismatchError",
  "InvalidJwtSigningMaterialError",
  "PortAllocationError",
  "PortUnavailableError",
  "StackPreparationError",
  "ArtifactIntegrityError",
  "ContainerPullError",
  "StackRuntimeError",
  "StackCleanupError",
  "ContainerEngineError",
  "UncertainOperationError",
] as const satisfies ReadonlyArray<StackErrorTag>;
export type StackStartError = ErrorByTag<(typeof STACK_START_ERROR_TAGS)[number]>;

/** Stable maintenance stop reports cleanup failures as lifecycle conflicts with their message. */
export const STACK_STOP_ERROR_TAGS = [
  "StackOwnershipConflictError",
  "OwnerRetiringError",
  "StackLifecycleConflictError",
  "StackStateInvalidError",
  "StackCleanupError",
  "UncertainOperationError",
] as const satisfies ReadonlyArray<StackErrorTag>;
export type StackStopError = ErrorByTag<(typeof STACK_STOP_ERROR_TAGS)[number]>;

export const STACK_LOGS_ERROR_TAGS = [
  "StackNotFoundError",
  "StackNotRunningError",
  "StackStateInvalidError",
  "InvalidLogCursorError",
  "StackOwnershipConflictError",
  "OwnerRetiringError",
  "StackLifecycleConflictError",
  "StackUpgradeRequiredError",
] as const satisfies ReadonlyArray<StackErrorTag>;
export type StackLogsError = ErrorByTag<(typeof STACK_LOGS_ERROR_TAGS)[number]>;

export const DESTROY_STACK_ERROR_TAGS = [
  "StackDestructionError",
  "StackNotFoundError",
  "StackOwnershipConflictError",
  "OwnerRetiringError",
  "StackLifecycleConflictError",
  "ContainerEngineError",
  "StackCleanupError",
  "StackUpgradeRequiredError",
  "UncertainOperationError",
] as const satisfies ReadonlyArray<StackErrorTag>;
export type DestroyStackError = ErrorByTag<(typeof DESTROY_STACK_ERROR_TAGS)[number]>;

export const POSTGRES_CLIENT_ERROR_TAGS = [
  "PostgresClientError",
  "StackVersionUnsupportedError",
  "StackPreparationError",
  "ArtifactIntegrityError",
  "ContainerPullError",
  "ContainerEngineError",
] as const satisfies ReadonlyArray<StackErrorTag>;
export type PostgresClientRunError = ErrorByTag<(typeof POSTGRES_CLIENT_ERROR_TAGS)[number]>;
