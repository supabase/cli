import { Data } from "effect";

/**
 * `supabase/config.toml` already exists and `--force` was not set. Reproduces
 * Go's wrapped `O_EXCL` open error from `utils.InitConfig`
 * (`apps/cli-go/internal/utils/config.go:243-246`) — a `*os.PathError` passed
 * through verbatim, so the message is platform-specific:
 * `failed to create config file: open supabase/config.toml: file exists` on
 * Linux/macOS (POSIX `EEXIST` text), and
 * `failed to create config file: open supabase\config.toml: The file exists.`
 * on Windows (`filepath.Join` separator + `ERROR_FILE_EXISTS` errno text) —
 * plus the `utils.CmdSuggestion` set in `apps/cli-go/internal/init/init.go:38-42`
 * (platform-independent, since `errors.Is(err, os.ErrExist)` matches
 * `ERROR_FILE_EXISTS` too).
 */
export class LegacyInitConfigExistsError extends Data.TaggedError("LegacyInitConfigExistsError")<{
  readonly message: string;
  readonly suggestion: string;
}> {}

/**
 * `--use-orioledb` without `--experimental`. Reproduces cobra's
 * `MarkFlagRequired("experimental")` PreRun error from
 * `apps/cli-go/cmd/init.go:32-36`, byte-for-byte
 * (`required flag(s) "experimental" not set`). No suggestion — Go's
 * `recoverAndExit` appends the generic `--debug` troubleshooting hint, which
 * the text output layer's `fail` already adds when `suggestion` is unset.
 */
export class LegacyInitExperimentalRequiredError extends Data.TaggedError(
  "LegacyInitExperimentalRequiredError",
)<{
  readonly message: string;
}> {}
