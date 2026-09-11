import { Effect, Layer, type Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import { CliArgs } from "../../../shared/cli/cli-args.service.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { SeedLinkedFlag, SeedLocalFlag } from "../seed.flags.ts";
import { assertSeedTargetsExclusive } from "./buckets.flags.ts";
import { stdinLayer } from "../../../shared/runtime/stdin.layer.ts";
import { storageGatewayRuntimeLayer } from "../../../command-internal/storage-runtime.layer.ts";
import { seedBuckets } from "./buckets.handler.ts";

const config = {
  // TS-only flag; see push.command.ts (db push) for the same pattern.
  projectRef: Flag.String("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
};

// `--linked`/`--local` are scoped globals on the `seed` group (`seed.flags.ts`); the handler
// selects the target from the changed argv set, not these parsed values.
export type BucketsFlags = {
  readonly linked: boolean;
  readonly local: boolean;
  readonly projectRef: Option.Option<string>;
};

export const bucketsCommand = Command.make("buckets", config).pipe(
  Command.withDescription("Seed buckets declared in [storage.buckets]."),
  Command.withShortDescription("Seed buckets declared in [storage.buckets]"),
  Command.withHandler((leafFlags) =>
    Effect.gen(function* () {
      // Enforce --local/--linked mutual exclusivity before instrumentation, so a
      // flag-validation rejection doesn't emit `cli_command_executed`.
      const cliArgs = yield* CliArgs;
      yield* assertSeedTargetsExclusive(cliArgs.args);
      // Persistent seed-group flags for the telemetry flags map; target selection
      // itself uses the changed set above.
      const flags: BucketsFlags = {
        linked: yield* SeedLinkedFlag,
        local: yield* SeedLocalFlag,
        projectRef: leafFlags.projectRef,
      };
      return yield* seedBuckets(flags).pipe(
        withCommandTelemetry({
          flags: {
            linked: flags.linked,
            local: flags.local,
            "project-ref": flags.projectRef,
          },
          // Not in the safe-flags allowlist, so this stays redacted.
        }),
      );
    }).pipe(withJsonErrorHandling),
  ),
  Command.provide(Layer.mergeAll(storageGatewayRuntimeLayer(["seed", "buckets"]), stdinLayer)),
);
