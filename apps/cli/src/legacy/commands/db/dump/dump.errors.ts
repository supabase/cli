import { Data } from "effect";

/**
 * `--use-copy` / `--exclude` were passed without `--data-only`. Reproduces
 * cobra's `MarkFlagRequired("data-only")` PreRun error from
 * `apps/cli-go/cmd/db.go:134-137`, byte-for-byte.
 */
export class LegacyDbDumpRequiresDataOnlyError extends Data.TaggedError(
  "LegacyDbDumpRequiresDataOnlyError",
)<{
  readonly message: string;
}> {}

/**
 * Two mutually exclusive flags were set together. Reproduces cobra's
 * `MarkFlagsMutuallyExclusive` errors (`apps/cli-go/cmd/db.go:434,436,441,445`),
 * byte-for-byte.
 */
export class LegacyDbDumpMutuallyExclusiveFlagsError extends Data.TaggedError(
  "LegacyDbDumpMutuallyExclusiveFlagsError",
)<{
  readonly message: string;
}> {}

/**
 * Failed to open the `--file` output path. Byte-matches Go's
 * `"failed to open dump file: " + err` (`apps/cli-go/internal/db/dump/dump.go:27`).
 */
export class LegacyDbDumpOpenFileError extends Data.TaggedError("LegacyDbDumpOpenFileError")<{
  readonly message: string;
}> {}

/**
 * The pg_dump container exited non-zero. Byte-matches Go's
 * `"error running container: exit " + code` (`DockerStreamLogs`).
 */
export class LegacyDbDumpRunError extends Data.TaggedError("LegacyDbDumpRunError")<{
  readonly message: string;
  // Go attaches an actionable hint (`utils.CmdSuggestion`) to a failed dump via
  // `SetConnectSuggestion`/`SuggestIPv6Pooler` before returning — e.g. the IPv6
  // transaction-pooler guidance. `Output.fail` prints it bare on stderr after the
  // error message, mirroring Go's `recoverAndExit`.
  readonly suggestion?: string;
}> {}
