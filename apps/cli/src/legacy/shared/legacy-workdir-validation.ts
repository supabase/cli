import { Data, Effect, FileSystem } from "effect";

/**
 * Raised by {@link legacyValidateWorkdirIsDirectory} when the target path
 * doesn't exist or isn't a directory. Callers map this into their own
 * command-specific error type.
 */
export class LegacyWorkdirValidationError extends Data.TaggedError("LegacyWorkdirValidationError")<{
  readonly message: string;
}> {}

/**
 * Validates that `workdir` exists and is a directory, the way Go's
 * `ChangeWorkDir` implicitly does via `os.Chdir` (`apps/cli-go/internal/utils/
 * misc.go:231-250`, called from `PersistentPreRunE`, `apps/cli-go/cmd/root.go:
 * 93-105`, before any command runs): a missing path or a path that isn't a
 * directory fails immediately, before config load or any Docker/API access.
 *
 * Callers that resolve `workdir` via `LegacyCliConfig` only need this check
 * when `--workdir`/`SUPABASE_WORKDIR` was set explicitly — `legacy-cli-config.
 * layer.ts`'s default walk-up-for-`supabase/config.toml` resolution always
 * returns a real, already-existing directory (either one containing
 * `supabase/config.toml`, or the process's own `cwd`), so it can never fail
 * this check; calling it unconditionally is therefore safe and simpler than
 * threading "was this explicit?" through every caller.
 */
export function legacyValidateWorkdirIsDirectory(
  workdir: string,
  fs: FileSystem.FileSystem,
): Effect.Effect<void, LegacyWorkdirValidationError> {
  return fs.stat(workdir).pipe(
    Effect.matchEffect({
      onFailure: (error) => {
        const reason =
          error.reason._tag === "NotFound" ? "no such file or directory" : error.message;
        return Effect.fail(
          new LegacyWorkdirValidationError({
            message: `failed to change workdir: chdir ${workdir}: ${reason}`,
          }),
        );
      },
      onSuccess: (info) =>
        info.type === "Directory"
          ? Effect.void
          : Effect.fail(
              new LegacyWorkdirValidationError({
                message: `failed to change workdir: chdir ${workdir}: not a directory`,
              }),
            ),
    }),
  );
}
