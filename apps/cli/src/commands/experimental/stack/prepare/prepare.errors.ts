import { Data, Match } from "effect";
import { isStackError } from "@supabase/stack/effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../../shared/telemetry/error-actionability.ts";

export class StackCommandPrepareError extends Data.TaggedError("ExperimentalStackPrepareError")<{
  readonly reason:
    | "flags"
    | "invalid-config"
    | "runtime"
    | "registry"
    | "artifact"
    | "lifecycle"
    | "unknown";
  readonly message: string;
  readonly suggestion?: string;
  readonly cause?: unknown;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    switch (this.reason) {
      case "flags":
        return actionability.provideFlags;
      case "invalid-config":
        return actionability.invalidConfig;
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

export const stackPrepareError = (error: unknown): StackCommandPrepareError => {
  const stackError = isStackError(error) ? error : undefined;
  const classification =
    stackError === undefined
      ? { reason: "unknown" as const }
      : Match.value(stackError).pipe(
          Match.tag("ContainerEngineError", () => ({
            reason: "runtime" as const,
            suggestion:
              "Check that the selected container engine is installed and its daemon is running, then retry the command.",
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
            () => ({ reason: "invalid-config" as const }),
          ),
          Match.tag("StackStateInvalidError", () => ({
            reason: "invalid-config" as const,
            suggestion:
              "Inspect the reported state error and restore a valid state record before retrying.",
          })),
          Match.tag("StackStateFormatUnsupportedError", () => ({
            reason: "invalid-config" as const,
            suggestion: "Use a CLI version compatible with the persisted stack state.",
          })),
          Match.tag("StackNotFoundError", () => ({
            reason: "flags" as const,
          })),
          Match.tag("StackRuntimeMismatchError", () => ({
            reason: "flags" as const,
            suggestion:
              "Omit --runtime to reuse the existing runtime, or choose a different --stack name.",
          })),
          Match.tag("StackOwnershipConflictError", "StackUpgradeRequiredError", () => ({
            reason: "lifecycle" as const,
            suggestion: "Resolve the existing stack state before preparing it again.",
          })),
          Match.orElse(() => ({ reason: "unknown" as const })),
        );
  return new StackCommandPrepareError({
    ...classification,
    message: stackError?.message ?? String(error),
    ...("suggestion" in classification ? { suggestion: classification.suggestion } : {}),
    cause: error,
  });
};
