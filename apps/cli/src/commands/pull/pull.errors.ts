import { Data } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../shared/telemetry/error-actionability.ts";

/** The global `-o`/`--output` flag was passed; `pull` only supports `--output-format` for
 *  machine output. */
export class PullOutputFlagUnsupportedError extends Data.TaggedError(
  "PullOutputFlagUnsupportedError",
)<{ readonly message: string }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

/**
 * The resolved `--workdir`/`SUPABASE_WORKDIR` doesn't exist or isn't a
 * directory. Only reachable when the user explicitly set it — beats every
 * step's own target resolution and network calls.
 */
export class PullWorkdirError extends Data.TaggedError("PullWorkdirError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * At least one of the config file, `supabase/migrations`, or `supabase/functions` has
 * uncommitted or untracked changes with no interactive prompt to confirm past it. Only
 * `--force` overrides this guard; `--yes` never does.
 */
export class PullUncommittedChangesError extends Data.TaggedError("PullUncommittedChangesError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}
