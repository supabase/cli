import { Data, Match } from "effect";
import { isStackError } from "@supabase/stack/effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../../shared/telemetry/error-actionability.ts";

export class LegacyExperimentalStackPrepareError extends Data.TaggedError(
  "LegacyExperimentalStackPrepareError",
)<{
  readonly reason:
    | "invalid-config"
    | "flags"
    | "runtime"
    | "registry"
    | "artifact"
    | "lifecycle"
    | "unknown";
  readonly message: string;
  readonly detail?: string;
  readonly suggestion?: string;
  readonly cause?: unknown;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    switch (this.reason) {
      case "invalid-config":
        return actionability.invalidConfig;
      case "flags":
        return actionability.provideFlags;
      case "runtime":
        return actionability.dockerNotRunning;
      case "registry":
      case "artifact":
        return actionability.externalNetwork;
      case "lifecycle":
        return actionability.invalidConfig;
      case "unknown":
        return actionability.unknown;
    }
  }
}

export const legacyStackPrepareError = (error: unknown) => {
  const stackError = isStackError(error) ? error : undefined;
  const message = stackError === undefined ? String(error) : stackError.message;
  const classification =
    stackError === undefined
      ? { reason: "unknown" as const }
      : Match.value(stackError).pipe(
          Match.tag("ContainerEngineError", () => ({
            reason: "runtime" as const,
            suggestion: "Ensure the selected container engine is running and retry the command.",
          })),
          Match.tag("ContainerPullError", () => ({
            reason: "registry" as const,
            suggestion:
              "Check registry connectivity and image availability, then retry the command.",
          })),
          Match.tag("StackPreparationError", "ArtifactIntegrityError", () => ({
            reason: "artifact" as const,
            suggestion:
              "Retry the stack preparation with --debug if the artifact cannot be prepared.",
          })),
          Match.tag(
            "InvalidStackConfigError",
            "StackVersionUnsupportedError",
            "InvalidStackIdentityError",
            "InvalidProjectRootError",
            "StackSecretMismatchError",
            "InvalidJwtSigningMaterialError",
            () => ({ reason: "invalid-config" as const }),
          ),
          Match.tag("StackNotFoundError", "StackRuntimeMismatchError", () => ({
            reason: "flags" as const,
          })),
          Match.tag(
            "StackOwnershipConflictError",
            "StackNotRunningError",
            "StackMustBeStoppedError",
            "StackLifecycleConflictError",
            "StackUpgradeRequiredError",
            "StackRuntimeError",
            "StackCleanupError",
            () => ({
              reason: "lifecycle" as const,
              suggestion: "Resolve the existing stack state before preparing it again.",
            }),
          ),
          Match.orElse(() => ({ reason: "unknown" as const })),
        );
  return new LegacyExperimentalStackPrepareError({
    ...classification,
    message,
    ...("suggestion" in classification ? { suggestion: classification.suggestion } : {}),
    cause: error,
  });
};
