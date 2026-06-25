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
 * slice and their direct children (`root.go:56-74`), which includes `storageCmd`.
 * Go enforces this in `PersistentPreRunE` — after cobra's arg + flag-group
 * validation but before `RunE`/`PersistentPostRun` — so a closed gate must NOT
 * emit `cli_command_executed` or write the telemetry/linked-project files. Each
 * native experimental leaf therefore calls this in its `.command.ts` AFTER the
 * mutual-exclusivity check and BEFORE `withLegacyCommandInstrumentation`.
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
