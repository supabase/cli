import type { Effect } from "effect";
import { Context, Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../shared/telemetry/error-actionability.ts";

export class CliProjectHomeNotDirectoryError extends Data.TaggedError(
  "CliProjectHomeNotDirectoryError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

interface CliProjectHomeShape {
  readonly projectRoot: string;
  readonly supabaseDir: string;
  readonly projectHomeDir: string;
  readonly projectLinkPath: string;
  readonly projectLocalVersionsPath: string;
  readonly ensureCliProjectHomeDir: Effect.Effect<void>;
}

export class CliProjectHome extends Context.Service<CliProjectHome, CliProjectHomeShape>()(
  "supabase/cli/CliProjectHome",
) {}
