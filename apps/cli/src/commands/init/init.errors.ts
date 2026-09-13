import { Data } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../shared/telemetry/error-actionability.ts";

/**
 * `supabase/config.toml` already exists and `--force` was not set. The message reproduces the
 * platform's raw file-exists error text: `file exists` (POSIX) or `The file exists.` (Windows).
 */
export class InitConfigExistsError extends Data.TaggedError("InitConfigExistsError")<{
  readonly message: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * `--use-orioledb` without `--experimental`. Reproduces the established required-flag error
 * text verbatim: `required flag(s) "experimental" not set`. No suggestion — the text output
 * layer's `fail` already appends the generic `--debug` hint when unset.
 */
export class InitExperimentalRequiredError extends Data.TaggedError(
  "InitExperimentalRequiredError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}
