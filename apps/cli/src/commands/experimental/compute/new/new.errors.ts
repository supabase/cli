import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../../shared/telemetry/error-actionability.ts";

/**
 * The resolved `--workdir`/`SUPABASE_WORKDIR` doesn't exist or isn't a
 * directory (`validateWorkdirIsDirectory`). Only reachable when the user
 * explicitly set it — beats every prompt and filesystem write, so a typo'd
 * `--workdir` can never scaffold a fresh `supabase/compute/…` tree (plus a new
 * `config.toml`) at the wrong path. Mirrors `FunctionsNewWorkdirError`,
 * `new`'s sibling in `supabase functions`.
 */
export class ComputeNewWorkdirError extends Data.TaggedError("ComputeNewWorkdirError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}
