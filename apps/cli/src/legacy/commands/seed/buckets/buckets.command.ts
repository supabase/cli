import { Effect, Layer, type Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { LegacySeedLinkedFlag, LegacySeedLocalFlag } from "../seed.flags.ts";
import { legacyAssertSeedTargetsExclusive } from "./buckets.flags.ts";
import { stdinLayer } from "../../../../shared/runtime/stdin.layer.ts";
import { legacyStorageGatewayRuntimeLayer } from "../../../shared/legacy-storage-runtime.layer.ts";
import { legacySeedBuckets } from "./buckets.handler.ts";

const config = {
  // TS-only override of the linked project ref — see push.command.ts (db push).
  // No Go equivalent: `seed.go` never registers `--project-ref` on this command.
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
};

// `--linked`/`--local` are scoped globals on the `seed` group (`seed.flags.ts`),
// so this leaf only owns `--project-ref` above; the handler selects the target
// from the changed argv set, not these parsed values.
export type LegacyBucketsFlags = {
  readonly linked: boolean;
  readonly local: boolean;
  readonly projectRef: Option.Option<string>;
};

export const legacyBucketsCommand = Command.make("buckets", config).pipe(
  Command.withDescription("Seed buckets declared in [storage.buckets]."),
  Command.withShortDescription("Seed buckets declared in [storage.buckets]"),
  Command.withHandler((leafFlags) =>
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
        projectRef: leafFlags.projectRef,
      };
      return yield* legacySeedBuckets(flags).pipe(
        withLegacyCommandInstrumentation({
          flags: {
            linked: flags.linked,
            local: flags.local,
            "project-ref": flags.projectRef,
          },
          // TS-only flag with no Go telemetry-safety baseline; Go's nearest
          // --project-ref registrations (cmd/pgdelta_catalog.go:44 and most
          // others) are unmarked, so it stays redacted.
        }),
      );
    }).pipe(withJsonErrorHandling),
  ),
  Command.provide(
    Layer.mergeAll(legacyStorageGatewayRuntimeLayer(["seed", "buckets"]), stdinLayer),
  ),
);
