import { Data } from "effect";
import {
  actionability,
  causeDeclaration,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  unclassifiedStackFailureActionability,
} from "../../../../shared/telemetry/error-actionability.ts";
import { type StackTargetIssue, stackTargetInvalidConfigActionability } from "../stack.shared.ts";

export class StackCommandLogsError extends Data.TaggedError("ExperimentalStackLogsError")<{
  readonly reason: "flags" | "invalid-config" | "lifecycle" | "stack";
  readonly targetIssue?: StackTargetIssue;
  readonly message: string;
  readonly suggestion?: string;
  readonly cause?: unknown;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    switch (this.reason) {
      case "flags":
        return { ...actionability.provideFlags, fingerprint_suffix: "flags" };
      case "invalid-config":
        return stackTargetInvalidConfigActionability(this.targetIssue);
      case "lifecycle":
        return { ...actionability.invalidConfig, fingerprint_suffix: "lifecycle" };
      case "stack":
        return causeDeclaration(this.cause) ?? unclassifiedStackFailureActionability(this.cause);
    }
  }
}
