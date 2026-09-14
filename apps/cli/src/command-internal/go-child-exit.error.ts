import { Data, Runtime } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";

/**
 * A spawned `supabase-go` child process exited non-zero, or couldn't be spawned at all.
 *
 * Carries the exit code through `Runtime.errorExitCode` so it survives every `Effect.ensuring`
 * finalizer up to `runCli`'s own exit call, instead of exiting the process directly and skipping
 * them. `runCli` also special-cases this class to skip its own generic stderr line, since the
 * child already wrote its own failure detail there. `exitCode` must be a real non-zero status;
 * every construction site guards this before creating the error.
 */
export class GoChildExitError extends Data.TaggedError("GoChildExitError")<{
  readonly exitCode: number;
  readonly message: string;
}> {
  override readonly [Runtime.errorExitCode] = this.exitCode;

  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.unknown;
  }
}
