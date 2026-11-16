import { Data } from "effect";
import {
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../../shared/telemetry/error-actionability.ts";
import type { StackTargetIssue } from "../../../../command-internal/stack-target.ts";
import {
  type StackCommandDestroyError,
  stackDestroyActionability,
} from "../destroy/destroy.errors.ts";

export class StackCommandPruneError extends Data.TaggedError("ExperimentalStackPruneError")<{
  readonly reason: StackCommandDestroyError["reason"];
  readonly targetIssue?: StackTargetIssue;
  readonly message: string;
  readonly detail?: string;
  readonly suggestion?: string;
  readonly cause?: unknown;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return stackDestroyActionability(this);
  }
}
