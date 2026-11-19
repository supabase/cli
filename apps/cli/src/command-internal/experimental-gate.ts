import { Data, Effect } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";
import { resolveExperimental } from "./global-flags.ts";
import { defineExperimentalAccess } from "./command-access-policy.ts";

/**
 * Gates access to experimental commands and their children. Must run before any
 * mutual-exclusivity check, `withCommandTelemetry`, and any telemetry/linked-project file write —
 * a closed gate must produce none of those side effects. Each native experimental leaf annotates
 * {@link requiredExperimentalAccess} and runs its check first in its `.command.ts` for this reason. The message text and
 * the `SUPABASE_EXPERIMENTAL` env fallback (see {@link resolveExperimental}) are established
 * behavior and must not change casually.
 */
export class ExperimentalRequiredError extends Data.TaggedError("ExperimentalRequiredError")<{
  readonly message: string;
}> {
  constructor() {
    super({ message: "must set the --experimental flag to run this command" });
  }

  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/** Fails with {@link ExperimentalRequiredError} unless experimental is enabled. */
export const requiredExperimentalAccess = defineExperimentalAccess({
  experimental: "required",
  check: Effect.gen(function* () {
    if (yield* resolveExperimental) return;
    return yield* new ExperimentalRequiredError();
  }),
});

/**
 * Flag-conditional experimental check for commands that stay stable; the pairing test rejects it
 * in unannotated commands outside its allowlist.
 */
export const requireExperimental = requiredExperimentalAccess.check;
