import { Data, Effect, FileSystem } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";

/**
 * Raised by {@link validateWorkdirIsDirectory} when the target path doesn't exist or isn't a
 * directory. Only reachable when the user explicitly set `--workdir`/`SUPABASE_WORKDIR` to a bad
 * path; the fix is always to pass a different one.
 */
export class WorkdirValidationError extends Data.TaggedError("WorkdirValidationError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * Validates that `workdir` exists and is a directory, failing immediately before config load or
 * any Docker/API access.
 *
 * Only needed when `--workdir`/`SUPABASE_WORKDIR` was set explicitly — the default walk-up
 * resolution always returns an already-existing directory, so calling this unconditionally is
 * safe and simpler than threading "was this explicit?" through every caller.
 */
export function validateWorkdirIsDirectory(
  workdir: string,
  fs: FileSystem.FileSystem,
): Effect.Effect<void, WorkdirValidationError> {
  return fs.stat(workdir).pipe(
    Effect.matchEffect({
      onFailure: (error) => {
        const reason =
          error.reason._tag === "NotFound" ? "no such file or directory" : error.message;
        return Effect.fail(
          new WorkdirValidationError({
            message: `failed to change workdir: chdir ${workdir}: ${reason}`,
          }),
        );
      },
      onSuccess: (info) =>
        info.type === "Directory"
          ? Effect.void
          : Effect.fail(
              new WorkdirValidationError({
                message: `failed to change workdir: chdir ${workdir}: not a directory`,
              }),
            ),
    }),
  );
}
