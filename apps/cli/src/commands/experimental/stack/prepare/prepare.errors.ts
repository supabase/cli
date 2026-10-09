import type { StackError } from "@supabase/stack/effect";
import { Data } from "effect";
import {
  actionability,
  causeDeclaration,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  unclassifiedStackFailureActionability,
} from "../../../../shared/telemetry/error-actionability.ts";

export class StackCommandPrepareError extends Data.TaggedError("ExperimentalStackPrepareError")<{
  readonly reason: "flags" | "invalid-config" | "runtime" | "lifecycle" | "stack";
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
      case "runtime":
        return { ...actionability.dockerNotRunning, fingerprint_suffix: "docker_not_running" };
      case "lifecycle":
        return { ...actionability.invalidConfig, fingerprint_suffix: "lifecycle" };
      case "stack":
        return causeDeclaration(this.cause) ?? unclassifiedStackFailureActionability;
    }
  }
}

/** Maps an internal stack failure to the prepare command's stable error boundary. */
export const stackPrepareError = (error: StackError): StackCommandPrepareError =>
  new StackCommandPrepareError({
    reason: "stack",
    message: error.message,
    cause: error,
  });
