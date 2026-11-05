import { Effect, Layer } from "effect";
import { Command } from "effect/cli";

import { withCliConfigFlags } from "../../../config/cli-config-flags.ts";
import { cliConfigValuesLayer } from "../../../config/cli-config-values.layer.ts";
import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import {
  readSeedTargetFlags,
  type TargetFlagValues,
} from "../../../command-internal/target/target-flags.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { stdinLayer } from "../../../shared/runtime/stdin.layer.ts";
import { storagePermissions } from "../../../command-internal/storage-permissions.ts";
import { storageGatewayRuntimeLayer } from "../../../command-internal/storage-runtime.layer.ts";
import { seedBuckets } from "./buckets.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";

export type BucketsFlags = TargetFlagValues;

export const bucketsCommand = Command.make("buckets").pipe(
  Command.withDescription(
    "Create or update the Storage buckets declared in the project config file and upload the files from each bucket's objects_path. A remote project asks for confirmation before the first write.",
  ),
  Command.withShortDescription("Seed Storage buckets from the project config file"),
  Command.withExamples([
    { command: "supabase seed buckets", description: "Seed buckets on the local stack" },
    {
      command: "supabase seed buckets --remote",
      description: "Seed buckets on the linked project",
    },
  ]),
  withPermissions(storagePermissions([])),
  Command.withHandler(() =>
    Effect.gen(function* () {
      const flags: BucketsFlags = yield* readSeedTargetFlags();
      return yield* seedBuckets(flags).pipe(withCommandTelemetry());
    }).pipe(withJsonErrorHandling),
  ),
  Command.provide(Layer.mergeAll(storageGatewayRuntimeLayer(["seed", "buckets"]), stdinLayer)),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags({}),
  withTargetPolicy({ group: "selectable", consent: "no" }),
);
