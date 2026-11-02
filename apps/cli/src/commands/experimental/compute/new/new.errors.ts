import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../../shared/telemetry/error-actionability.ts";

/**
 * The resolved `--workdir`/`SUPABASE_WORKDIR` doesn't exist or isn't a
 * directory. Only reachable when the user explicitly set it — checked before
 * every prompt and filesystem write, so a typo'd `--workdir` can never
 * scaffold a fresh `supabase/compute/…` tree at the wrong path.
 */
export class ComputeNewWorkdirError extends Data.TaggedError("ComputeNewWorkdirError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}
