import { Data } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../shared/telemetry/error-actionability.ts";

/**
 * `supabase/config.toml` already exists and `--force` was not set. Reproduces
 * the wrapped `O_EXCL` open error from `utils.InitConfig`
 * (`apps/cli-go/internal/utils/config.go:243-246`) — a `*os.PathError` passed
 * through verbatim, so the message is platform-specific:
 * `failed to create config file: open supabase/config.toml: file exists` on
 * Linux/macOS (POSIX `EEXIST` text), and
 * `failed to create config file: open supabase\config.toml: The file exists.`
 * on Windows (`filepath.Join` separator + `ERROR_FILE_EXISTS` errno text) —
 * plus the `utils.CmdSuggestion` set (platform-independent, since
 * `errors.Is(err, os.ErrExist)` matches `ERROR_FILE_EXISTS` too).
 */
export class LegacyInitConfigExistsError extends Data.TaggedError("LegacyInitConfigExistsError")<{
  readonly message: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * `--use-orioledb` without `--experimental`. Reproduces cobra's
 * `MarkFlagRequired("experimental")` PreRun error, byte-for-byte
 * (`required flag(s) "experimental" not set`). No suggestion — `recoverAndExit`
 * appends the generic `--debug` troubleshooting hint, which the text output
 * layer's `fail` already adds when `suggestion` is unset.
 */
export class LegacyInitExperimentalRequiredError extends Data.TaggedError(
  "LegacyInitExperimentalRequiredError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}
