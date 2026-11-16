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
