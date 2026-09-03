import { Data } from "effect";

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

export class StackDefinitionRequiredError extends Data.TaggedError(
  "StackDefinitionRequiredError",
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

export class GatewayAuthenticationError extends Data.TaggedError(
  "GatewayAuthenticationError",
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

export class StackReconciliationError extends Data.TaggedError(
  "StackReconciliationError",
)<StackErrorFields> {}
export class ServiceStartError extends Data.TaggedError("ServiceStartError")<StackErrorFields> {}
export class ServiceReadinessError extends Data.TaggedError(
  "ServiceReadinessError",
)<StackErrorFields> {}
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
  "StackDefinitionRequiredError",
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
  "GatewayAuthenticationError",
  "GatewayActivationError",
  "StackPreparationError",
  "ArtifactIntegrityError",
  "ContainerPullError",
  "StackReconciliationError",
  "ServiceStartError",
  "ServiceReadinessError",
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
  | StackDefinitionRequiredError
  | StackNotRunningError
  | StackMustBeStoppedError
  | StackLifecycleConflictError
  | StackStateInvalidError
  | StackStateFormatUnsupportedError
  | StackUpgradeRequiredError
  | StackSecretMismatchError
  | InvalidJwtSigningMaterialError
  | PortAllocationError
  | PortUnavailableError
  | GatewayAuthenticationError
  | GatewayActivationError
  | StackPreparationError
  | ArtifactIntegrityError
  | ContainerPullError
  | StackReconciliationError
  | ServiceStartError
  | ServiceReadinessError
  | ContainerEngineError
  | StackDestructionError;

export type CreateStackError =
  | InvalidStackIdentityError
  | InvalidProjectRootError
  | StackOwnershipConflictError
  | StackRuntimeMismatchError
  | ContainerEngineError
  | StackStateInvalidError
  | StackStateFormatUnsupportedError;
export type OpenStackError =
  | StackNotFoundError
  | StackOwnershipConflictError
  | StackRuntimeMismatchError
  | InvalidProjectRootError
  | StackStateInvalidError
  | StackStateFormatUnsupportedError
  | StackUpgradeRequiredError;
export type StackDiscoveryError =
  | InvalidStackIdentityError
  | InvalidProjectRootError
  | StackStateInvalidError
  | StackStateFormatUnsupportedError;
export type StackStatusError =
  | StackNotFoundError
  | StackOwnershipConflictError
  | StackLifecycleConflictError
  | StackStateInvalidError
  | StackStateFormatUnsupportedError
  | StackUpgradeRequiredError;
export type StackCredentialsError =
  | StackNotFoundError
  | StackNotRunningError
  | StackOwnershipConflictError
  | StackLifecycleConflictError
  | StackSecretMismatchError
  | InvalidJwtSigningMaterialError;
export type PrepareStackError =
  | StackPreparationError
  | ArtifactIntegrityError
  | ContainerPullError
  | StackOwnershipConflictError
  | StackStateInvalidError
  | StackLifecycleConflictError;
export type StackStartError =
  | InvalidStackConfigError
  | StackDefinitionRequiredError
  | StackVersionUnsupportedError
  | StackOwnershipConflictError
  | StackNotRunningError
  | StackMustBeStoppedError
  | StackLifecycleConflictError
  | StackStateInvalidError
  | StackStateFormatUnsupportedError
  | StackUpgradeRequiredError
  | StackSecretMismatchError
  | InvalidJwtSigningMaterialError
  | PortAllocationError
  | PortUnavailableError
  | StackPreparationError
  | ArtifactIntegrityError
  | ContainerPullError
  | StackReconciliationError
  | ServiceStartError
  | ServiceReadinessError
  | ContainerEngineError;
/** Stable maintenance stop reports cleanup failures as lifecycle conflicts with their message. */
export type StackStopError = StackOwnershipConflictError | StackLifecycleConflictError;
export type StackLogsError =
  | StackNotFoundError
  | StackNotRunningError
  | StackStateInvalidError
  | StackOwnershipConflictError
  | StackLifecycleConflictError;
export type DestroyStackError =
  | StackDestructionError
  | StackNotFoundError
  | StackOwnershipConflictError
  | StackLifecycleConflictError
  | ContainerEngineError;
