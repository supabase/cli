import { Data } from "effect";
import type { StackId } from "./StackId.ts";

export class InvalidStackIdentityError extends Data.TaggedError("InvalidStackIdentityError")<{
  readonly message: string;
  readonly cause?: unknown;
  readonly path?: string;
  readonly reason?: string;
  readonly stackId?: StackId;
  readonly name?: string;
}> {}

export class InvalidProjectRootError extends Data.TaggedError("InvalidProjectRootError")<{
  readonly message: string;
  readonly cause?: unknown;
  readonly projectRoot?: string;
  readonly stateRoot?: string;
}> {}
