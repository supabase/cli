import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacyAssertSeedTargetsExclusive } from "./buckets.flags.ts";
import { legacySeedRuntimeLayer } from "../seed.layers.ts";
import { legacySeedBuckets } from "./buckets.handler.ts";

const config = {
  linked: Flag.boolean("linked").pipe(Flag.withDescription("Seeds the linked project.")),
  local: Flag.boolean("local").pipe(Flag.withDescription("Seeds the local database.")),
} as const;

export type LegacyBucketsFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyBucketsCommand = Command.make("buckets", config).pipe(
  Command.withDescription("Seed buckets declared in [storage.buckets]."),
  Command.withShortDescription("Seed buckets declared in [storage.buckets]"),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      // Enforce --local/--linked mutual exclusivity BEFORE instrumentation, so a
      // flag-validation rejection doesn't emit `cli_command_executed` (Go rejects
      // it at cobra flag validation, before RunE/PostRun).
      const cliArgs = yield* CliArgs;
      yield* legacyAssertSeedTargetsExclusive(cliArgs.args);
      return yield* legacySeedBuckets(flags).pipe(withLegacyCommandInstrumentation({ flags }));
    }).pipe(withJsonErrorHandling),
  ),
  Command.provide(legacySeedRuntimeLayer(["seed", "buckets"])),
);
