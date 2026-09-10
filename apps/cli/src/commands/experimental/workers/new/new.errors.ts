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
 * scaffold a fresh `supabase/workers/…` tree at the wrong path.
 */
export class WorkersNewWorkdirError extends Data.TaggedError("WorkersNewWorkdirError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}
