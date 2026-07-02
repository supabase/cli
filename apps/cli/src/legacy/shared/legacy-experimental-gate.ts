import { Data, Effect } from "effect";

import { legacyResolveExperimental } from "../../shared/legacy/global-flags.ts";

/**
 * The Effect-CLI replacement for Go's root-level experimental gate
 * (`apps/cli-go/cmd/root.go:91-96`):
 *
 * ```go
 * if IsExperimental(cmd) && !viper.GetBool("EXPERIMENTAL") {
 *   return errors.New("must set the --experimental flag to run this command")
 * }
 * ```
 *
 * `IsExperimental` is true for the commands registered in the `experimental`
 * slice and their direct children (`root.go:56-74`).
 * Go enforces this in `PersistentPreRunE`, which cobra runs BEFORE
 * `ValidateFlagGroups()` (mutual-exclusivity checks) and `RunE`/`PersistentPostRun`
 * (`cobra@v1.10.2/command.go:985,1010,1014`) — so a closed gate must NOT run
 * mutual-exclusivity checks, emit `cli_command_executed`, or write the
 * telemetry/linked-project files. (Cobra's positional-argument count/type
 * validation, `ValidateArgs`, runs even earlier, at `command.go:968` — the gate
 * does not preempt that.) Each native experimental leaf therefore calls this in
 * its `.command.ts` before any mutual-exclusivity check and before
 * `withLegacyCommandInstrumentation` — the 4 pre-existing storage leaves
 * (`storage/{cp,ls,mv,rm}`) currently get this ordering wrong (mutex check
 * before the gate); do not copy them until that's fixed.
 *
 * The message byte-matches Go's `errors.New(...)`; the value is resolved with the
 * `SUPABASE_EXPERIMENTAL` viper fallback (see {@link legacyResolveExperimental}).
 */
export class LegacyExperimentalRequiredError extends Data.TaggedError(
  "LegacyExperimentalRequiredError",
)<{
  readonly message: string;
}> {
  constructor() {
    super({ message: "must set the --experimental flag to run this command" });
  }
}

/** Fails with {@link LegacyExperimentalRequiredError} unless experimental is enabled. */
export const legacyRequireExperimental = Effect.gen(function* () {
  if (yield* legacyResolveExperimental) return;
  return yield* new LegacyExperimentalRequiredError();
});
