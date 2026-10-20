import { Context, Data, type Effect, type Option } from "effect";
import type { PlatformError } from "effect/PlatformError";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";
import type { LegacyProjectStatePaths, LegacyStateFile } from "./legacy-project-state.paths.ts";

/**
 * A real failure reading `<workdir>/supabase/.temp/project-ref` (e.g. the
 * path is a directory, or permissions deny access) — distinct from the file
 * simply not existing, which means "not linked" rather than an error.
 */
export class ProjectRefReadError extends Data.TaggedError("ProjectRefReadError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.permission;
  }
}

interface LegacyProjectStateShape {
  /** Locations to hand to child processes or to I/O that needs its own error mapping. */
  readonly paths: (workdir: string) => LegacyProjectStatePaths;
  readonly exists: (
    workdir: string,
    file: LegacyStateFile,
  ) => Effect.Effect<boolean, PlatformError>;
  readonly read: (workdir: string, file: LegacyStateFile) => Effect.Effect<string, PlatformError>;
  /** Writes `content`, creating the state directory first. */
  readonly write: (
    workdir: string,
    file: LegacyStateFile,
    content: string,
  ) => Effect.Effect<void, PlatformError>;
  /** Removes `file`; an absent file is not an error. */
  readonly remove: (workdir: string, file: LegacyStateFile) => Effect.Effect<void, PlatformError>;
  /** Removes the whole state directory; an absent directory is not an error. */
  readonly removeAll: (workdir: string) => Effect.Effect<void, PlatformError>;
  /**
   * The linked project ref, `None` when the file is absent or blank. Any other read error
   * fails instead of being swallowed into an unlinked result.
   */
  readonly readProjectRef: (
    workdir: string,
  ) => Effect.Effect<Option.Option<string>, ProjectRefReadError>;
}

/** Owns reads and writes of the legacy `supabase/.temp` link and cache state. */
export class LegacyProjectState extends Context.Service<
  LegacyProjectState,
  LegacyProjectStateShape
>()("supabase/cli/LegacyProjectState") {}
