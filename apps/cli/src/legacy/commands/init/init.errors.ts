import { Data } from "effect";

/**
 * `supabase/config.toml` already exists and `--force` was not set. Reproduces
 * Go's wrapped `O_EXCL` open error from `utils.InitConfig`
 * (`apps/cli-go/internal/utils/config.go:243-246`) — a `*os.PathError` passed
 * through verbatim, so the message reads
 * `failed to create config file: open supabase/config.toml: file exists` —
 * plus the `utils.CmdSuggestion` set in `apps/cli-go/internal/init/init.go:38-42`.
 * Byte parity is scoped to Linux/macOS: Windows Go renders the OS path
 * separator and errno text, which this port does not reproduce.
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
