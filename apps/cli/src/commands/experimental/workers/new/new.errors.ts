import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../../shared/telemetry/error-actionability.ts";

/**
 * The resolved `--workdir`/`SUPABASE_WORKDIR` doesn't exist or isn't a
 * directory (`legacyValidateWorkdirIsDirectory`). Only reachable when the user
 * explicitly set it — beats every prompt and filesystem write, so a typo'd
 * `--workdir` can never scaffold a fresh `supabase/workers/…` tree (plus a new
 * `config.toml`) at the wrong path. Mirrors `LegacyFunctionsNewWorkdirError`,
 * `new`'s sibling in `supabase functions`.
 */
export class LegacyWorkersNewWorkdirError extends Data.TaggedError("LegacyWorkersNewWorkdirError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}
