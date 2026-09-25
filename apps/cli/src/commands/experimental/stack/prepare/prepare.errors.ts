import { StackError } from "@supabase/stack/effect";
import { Data, Schema } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../../shared/telemetry/error-actionability.ts";

export class StackCommandPrepareError extends Data.TaggedError("ExperimentalStackPrepareError")<{
  readonly reason: "flags" | "invalid-config" | "artifact" | "lifecycle" | "unknown";
  readonly message: string;
  readonly suggestion?: string;
  readonly cause?: unknown;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    switch (this.reason) {
      case "flags":
        return actionability.provideFlags;
      case "invalid-config":
      case "lifecycle":
        return actionability.invalidConfig;
      case "artifact":
        return actionability.externalNetwork;
      case "unknown":
        return actionability.unknown;
    }
  }
}

/** Maps an internal stack failure to the prepare command's stable error boundary. */
export const stackPrepareError = (error: unknown): StackCommandPrepareError => {
  const message =
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
      ? error.message
      : String(error);
  return new StackCommandPrepareError({
    reason: Schema.is(StackError)(error)
      ? error.operation === "prepareService"
        ? "artifact"
        : "unknown"
      : "unknown",
    message,
    cause: error,
  });
};
