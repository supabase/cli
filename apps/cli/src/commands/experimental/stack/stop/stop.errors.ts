import { Data } from "effect";
import {
  actionability,
  causeDeclaration,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  unclassifiedStackFailureActionability,
} from "../../../../shared/telemetry/error-actionability.ts";
import { type StackTargetIssue, stackTargetInvalidConfigActionability } from "../stack.shared.ts";

export class StackCommandStopError extends Data.TaggedError("ExperimentalStackStopError")<{
  readonly reason: "flags" | "invalid-config" | "stack";
  readonly targetIssue?: StackTargetIssue;
  readonly message: string;
  readonly detail?: string;
  readonly suggestion?: string;
  readonly cause?: unknown;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    switch (this.reason) {
      case "flags":
        return { ...actionability.provideFlags, fingerprint_suffix: "flags" };
      case "invalid-config":
        return stackTargetInvalidConfigActionability(this.targetIssue);
      case "stack":
        return causeDeclaration(this.cause) ?? unclassifiedStackFailureActionability(this.cause);
    }
  }
}
