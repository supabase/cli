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
  Command.withDescription("Seed buckets declared in [storage.buckets]."),
  Command.withShortDescription("Seed buckets declared in [storage.buckets]"),
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
