import { Data, Predicate } from "effect";

/**
 * Error context is intentionally open while operation-specific fields settle
 * with the runtime modules. The `_tag` on each class is the stable public
 * discriminator used by Effect.catchTag and Promise rejection handlers.
 */
export type StackErrorFields = Readonly<Record<string, unknown>>;

export class InvalidStackIdentityError extends Data.TaggedError(
  "InvalidStackIdentityError",
)<StackErrorFields> {}
export class InvalidProjectRootError extends Data.TaggedError(
  "InvalidProjectRootError",
)<StackErrorFields> {}
export class InvalidStackConfigError extends Data.TaggedError(
  "InvalidStackConfigError",
)<StackErrorFields> {}
export class StackVersionUnsupportedError extends Data.TaggedError(
  "StackVersionUnsupportedError",
)<StackErrorFields> {}

export class StackNotFoundError extends Data.TaggedError("StackNotFoundError")<StackErrorFields> {}
export class StackOwnershipConflictError extends Data.TaggedError(
  "StackOwnershipConflictError",
)<StackErrorFields> {}
export class StackRuntimeMismatchError extends Data.TaggedError(
  "StackRuntimeMismatchError",
)<StackErrorFields> {}

export class StackNotRunningError extends Data.TaggedError(
  "StackNotRunningError",
)<StackErrorFields> {}
export class StackMustBeStoppedError extends Data.TaggedError(
  "StackMustBeStoppedError",
)<StackErrorFields> {}
export class StackLifecycleConflictError extends Data.TaggedError(
  "StackLifecycleConflictError",
)<StackErrorFields> {}

export class StackStateInvalidError extends Data.TaggedError(
  "StackStateInvalidError",
)<StackErrorFields> {}
export class InvalidLogCursorError extends Data.TaggedError(
  "InvalidLogCursorError",
)<StackErrorFields> {}
export class StackStateFormatUnsupportedError extends Data.TaggedError(
  "StackStateFormatUnsupportedError",
)<StackErrorFields> {}
export class StackUpgradeRequiredError extends Data.TaggedError(
  "StackUpgradeRequiredError",
)<StackErrorFields> {}
export class StackSecretMismatchError extends Data.TaggedError(
  "StackSecretMismatchError",
)<StackErrorFields> {}
export class InvalidJwtSigningMaterialError extends Data.TaggedError(
  "InvalidJwtSigningMaterialError",
)<StackErrorFields> {}

export class PortAllocationError extends Data.TaggedError(
  "PortAllocationError",
)<StackErrorFields> {}
export class PortUnavailableError extends Data.TaggedError(
  "PortUnavailableError",
)<StackErrorFields> {}

export class GatewayActivationError extends Data.TaggedError(
  "GatewayActivationError",
)<StackErrorFields> {}

export class StackPreparationError extends Data.TaggedError(
  "StackPreparationError",
)<StackErrorFields> {}
export class ArtifactIntegrityError extends Data.TaggedError(
  "ArtifactIntegrityError",
)<StackErrorFields> {}
export class ContainerPullError extends Data.TaggedError("ContainerPullError")<StackErrorFields> {}

export class StackRuntimeError extends Data.TaggedError("StackRuntimeError")<StackErrorFields> {}
export class StackCleanupError extends Data.TaggedError("StackCleanupError")<StackErrorFields> {}
export class ContainerEngineError extends Data.TaggedError(
  "ContainerEngineError",
)<StackErrorFields> {}
export class StackDestructionError extends Data.TaggedError(
  "StackDestructionError",
)<StackErrorFields> {}

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
  "StackNotFoundError",
  "StackNotRunningError",
  "StackOwnershipConflictError",
  "StackLifecycleConflictError",
  "StackSecretMismatchError",
  "InvalidJwtSigningMaterialError",
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
  "StackOwnershipConflictError",
  "StackStateInvalidError",
  "StackStateFormatUnsupportedError",
  "StackLifecycleConflictError",
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
