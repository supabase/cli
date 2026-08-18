import { Data } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../shared/telemetry/error-actionability.ts";

/**
 * Reading `supabase/.temp/project-ref` failed for a reason other than the file
 * being absent (which maps to `LegacyProjectNotLinkedError`). Message format:
 * `"failed to load project ref: " + err`.
 */
export class LegacyUnlinkRefReadError extends Data.TaggedError("LegacyUnlinkRefReadError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.permission;
  }
}

/**
 * Removing the `supabase/.temp` directory failed. Byte-matches Go's
 * `"failed to remove temp directory: " + err` (`unlink.go:32`).
 */
export class LegacyUnlinkTempRemovalError extends Data.TaggedError("LegacyUnlinkTempRemovalError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.permission;
  }
}
