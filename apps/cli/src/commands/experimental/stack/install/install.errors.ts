import type { StackError } from "@supabase/stack/effect";
import { Data } from "effect";
import type { StackRuntimeSelectionError } from "../../../../command-internal/stack-runtime.ts";
import {
  actionability,
  causeDeclaration,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  unclassifiedStackFailureActionability,
} from "../../../../shared/telemetry/error-actionability.ts";

export class StackCommandInstallError extends Data.TaggedError("ExperimentalStackInstallError")<{
  readonly reason: "flags" | "invalid-config" | "lock" | "runtime" | "stack";
  readonly message: string;
  readonly suggestion?: string;
  readonly cause?: unknown;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    switch (this.reason) {
      case "flags":
        return { ...actionability.provideFlags, fingerprint_suffix: "flags" };
      case "invalid-config":
        return { ...actionability.invalidConfig, fingerprint_suffix: "invalid_config" };
      case "lock":
        return (
          causeDeclaration(this.cause) ?? {
            ...actionability.invalidConfig,
            fingerprint_suffix: "invalid_config",
          }
        );
      case "runtime":
        return { ...actionability.dockerNotRunning, fingerprint_suffix: "docker_not_running" };
      case "stack":
        return causeDeclaration(this.cause) ?? unclassifiedStackFailureActionability;
    }
  }
}

/** Maps a failed download to the install command's stable error boundary. */
export const stackInstallError = (error: StackError): StackCommandInstallError =>
  new StackCommandInstallError({ reason: "stack", message: error.message, cause: error });

/** Maps a failed runtime selection to the install command's stable error boundary. */
export const stackInstallRuntimeError = (
  error: StackRuntimeSelectionError,
): StackCommandInstallError =>
  new StackCommandInstallError({
    reason: error.reason === "native-unsupported" ? "flags" : "runtime",
    message: error.message,
    suggestion: error.suggestion,
    cause: error,
  });
