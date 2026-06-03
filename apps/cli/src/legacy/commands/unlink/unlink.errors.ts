import { Data } from "effect";

/**
 * Reading `supabase/.temp/project-ref` failed for a reason other than the file
 * being absent (which maps to `LegacyProjectNotLinkedError`). Byte-matches Go's
 * `"failed to load project ref: " + err` (`apps/cli-go/internal/unlink/unlink.go:19`).
 */
export class LegacyUnlinkRefReadError extends Data.TaggedError("LegacyUnlinkRefReadError")<{
  readonly message: string;
}> {}

/**
 * Removing the `supabase/.temp` directory failed. Byte-matches Go's
 * `"failed to remove temp directory: " + err` (`unlink.go:32`).
 */
export class LegacyUnlinkTempRemovalError extends Data.TaggedError("LegacyUnlinkTempRemovalError")<{
  readonly message: string;
}> {}
