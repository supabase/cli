import { Effect } from "effect";
import { Command } from "effect/unstable/cli";

import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { LegacySeedLinkedFlag, LegacySeedLocalFlag } from "../seed.flags.ts";
import { legacyAssertSeedTargetsExclusive } from "./buckets.flags.ts";
import { legacySeedRuntimeLayer } from "../seed.layers.ts";
import { legacySeedBuckets } from "./buckets.handler.ts";

// `--linked`/`--local` are scoped globals on the `seed` group (`seed.flags.ts`),
// so this leaf has no own flags; the handler selects the target from the changed
// argv set, not these parsed values.
export type LegacyBucketsFlags = {
  readonly linked: boolean;
  readonly local: boolean;
};

export const legacyBucketsCommand = Command.make("buckets").pipe(
  Command.withDescription("Seed buckets declared in [storage.buckets]."),
  Command.withShortDescription("Seed buckets declared in [storage.buckets]"),
  Command.withHandler(() =>
    Effect.gen(function* () {
      // Enforce --local/--linked mutual exclusivity BEFORE instrumentation, so a
      // flag-validation rejection doesn't emit `cli_command_executed` (Go rejects
      // it at cobra flag validation, before RunE/PostRun).
      const cliArgs = yield* CliArgs;
      yield* legacyAssertSeedTargetsExclusive(cliArgs.args);
      // Read the persistent seed-group flags for the telemetry flags map (Go logs
      // the resolved flag values); target selection itself uses the changed set.
      const flags: LegacyBucketsFlags = {
        linked: yield* LegacySeedLinkedFlag,
        local: yield* LegacySeedLocalFlag,
      };
      return yield* legacySeedBuckets(flags).pipe(withLegacyCommandInstrumentation({ flags }));
    }).pipe(withJsonErrorHandling),
  ),
  Command.provide(legacySeedRuntimeLayer(["seed", "buckets"])),
);
