import { Data, Predicate } from "effect";
import type { StackId } from "./StackId.ts";
import type { ContainerEngineKind } from "../runtime/ContainerEngine.ts";

/** Common context present on every public stack error. */
interface ErrorFields {
  readonly message: string;
  readonly cause?: unknown;
}

export interface IdentityErrorFields extends ErrorFields {
  readonly path?: string;
  readonly reason?: string;
  readonly projectRoot?: string;
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
  ErrorFields & { readonly stackId?: StackId }
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
  ErrorFields & { readonly capability?: string; readonly workload?: string }
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
export class StackDestructionError extends Data.TaggedError("StackDestructionError")<ErrorFields> {}

/** Stable wire tags for errors produced by the managed stack runtime. */
export const STACK_ERROR_TAGS = [
  "InvalidStackIdentityError",
  "InvalidProjectRootError",
  "InvalidStackConfigError",
  "StackVersionUnsupportedError",
  "StackNotFoundError",
  "StackOwnershipConflictError",
  "StackRuntimeMismatchError",
  "StackNotRunningError",
  "StackMustBeStoppedError",
  "StackLifecycleConflictError",
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
  | StackRuntimeMismatchError
  | StackNotRunningError
  | StackMustBeStoppedError
  | StackLifecycleConflictError
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
  | StackDestructionError;

export const isStackError = (value: unknown): value is StackError =>
  Predicate.hasProperty(value, "_tag") &&
  typeof value._tag === "string" &&
  isStackErrorTag(value._tag);

type ErrorByTag<Tag extends StackErrorTag> = Extract<StackError, { _tag: Tag }>;

export const CREATE_STACK_ERROR_TAGS = [
  "InvalidStackIdentityError",
  "InvalidProjectRootError",
  "StackOwnershipConflictError",
  "StackRuntimeMismatchError",
  "ContainerEngineError",
  "StackStateInvalidError",
  "StackStateFormatUnsupportedError",
] as const satisfies ReadonlyArray<StackErrorTag>;
export type CreateStackError = ErrorByTag<(typeof CREATE_STACK_ERROR_TAGS)[number]>;

export const OPEN_STACK_ERROR_TAGS = [
  "StackNotFoundError",
  "StackOwnershipConflictError",
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
] as const satisfies ReadonlyArray<StackErrorTag>;
export type StackStartError = ErrorByTag<(typeof STACK_START_ERROR_TAGS)[number]>;

/** Stable maintenance stop reports cleanup failures as lifecycle conflicts with their message. */
export const STACK_STOP_ERROR_TAGS = [
  "StackOwnershipConflictError",
  "StackLifecycleConflictError",
  "StackStateInvalidError",
  "StackCleanupError",
] as const satisfies ReadonlyArray<StackErrorTag>;
export type StackStopError = ErrorByTag<(typeof STACK_STOP_ERROR_TAGS)[number]>;

export const STACK_LOGS_ERROR_TAGS = [
  "StackNotFoundError",
  "StackNotRunningError",
  "StackStateInvalidError",
  "InvalidLogCursorError",
  "StackOwnershipConflictError",
  "StackLifecycleConflictError",
  "StackUpgradeRequiredError",
] as const satisfies ReadonlyArray<StackErrorTag>;
export type StackLogsError = ErrorByTag<(typeof STACK_LOGS_ERROR_TAGS)[number]>;

export const DESTROY_STACK_ERROR_TAGS = [
  "StackDestructionError",
  "StackNotFoundError",
  "StackOwnershipConflictError",
  "StackLifecycleConflictError",
  "ContainerEngineError",
  "StackCleanupError",
  "StackUpgradeRequiredError",
] as const satisfies ReadonlyArray<StackErrorTag>;
export type DestroyStackError = ErrorByTag<(typeof DESTROY_STACK_ERROR_TAGS)[number]>;
