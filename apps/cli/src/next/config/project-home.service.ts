import type { Effect } from "effect";
import { Context, Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../shared/telemetry/error-actionability.ts";

export class ProjectHomeNotDirectoryError extends Data.TaggedError("ProjectHomeNotDirectoryError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

interface ProjectHomeShape {
  readonly projectRoot: string;
  readonly supabaseDir: string;
  readonly projectHomeDir: string;
  readonly projectLinkPath: string;
  readonly projectLocalVersionsPath: string;
  readonly ensureProjectHomeDir: Effect.Effect<void>;
}

export class ProjectHome extends Context.Service<ProjectHome, ProjectHomeShape>()(
  "supabase/config/ProjectHome",
) {}
