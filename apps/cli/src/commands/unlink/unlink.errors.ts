import { Data } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../shared/telemetry/error-actionability.ts";

/**
 * Reading the linked project ref (`supabase/.temp/project-ref`, or `supabase/.link.json` in stack
 * mode) failed for a reason other than the file being absent (which maps to
 * `ProjectRefNotLinkedError`). Message format: `"failed to load project ref: " + err`.
 */
export class UnlinkRefReadError extends Data.TaggedError("UnlinkRefReadError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.permission;
  }
}

/** Removing the `supabase/.temp` directory, or `supabase/.link.json` in stack mode, failed. */
export class UnlinkTempRemovalError extends Data.TaggedError("UnlinkTempRemovalError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.permission;
  }
}
