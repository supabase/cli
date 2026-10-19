import { Effect, Layer, type Option } from "effect";
import { Command } from "effect/cli";

import { withCliConfigFlags } from "../../../config/cli-config-flags.ts";
import { cliConfigValuesLayer } from "../../../config/cli-config-values.layer.ts";
import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import {
  compose,
  withCondition,
  withDbTarget,
} from "../../../command-internal/command-permissions/model.ts";
import { storageCredentials } from "../../../command-internal/storage-credentials.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import {
  seedTargetGlobalFlags,
  targetFlags,
} from "../../../command-internal/target/target-flags.ts";
import { stdinLayer } from "../../../shared/runtime/stdin.layer.ts";
import { storageGatewayRuntimeLayer } from "../../../command-internal/storage-runtime.layer.ts";
import { seedBuckets } from "./buckets.handler.ts";
import type { RemoteValue } from "../../../command-internal/target/remote-value.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";

const config = {
  projectRef: targetFlags({ subject: "Storage API", dbUrl: false }).projectRef,
};

// `--remote`/`--linked`/`--local` are scoped globals on the `seed` group (`seedTargetGlobalFlags`).
export type BucketsFlags = {
  readonly remote: Option.Option<RemoteValue>;
  readonly linked: boolean;
  readonly local: boolean;
  readonly projectRef: Option.Option<string>;
};

export const bucketsCommand = Command.make("buckets", config).pipe(
  Command.withDescription("Seed buckets declared in [storage.buckets]."),
  Command.withShortDescription("Seed buckets declared in [storage.buckets]"),
  withPermissions(
    withDbTarget(
      compose(
        { operations: [], noApiEffectFlags: ["project-ref"] },
        withCondition(compose(storageCredentials, linkedProjectCache), { dbTarget: ["linked"] }),
      ),
      { default: "local" },
    ),
  ),
  Command.withHandler((leafFlags) =>
    Effect.gen(function* () {
      const flags: BucketsFlags = {
        remote: yield* seedTargetGlobalFlags.remote,
        linked: yield* seedTargetGlobalFlags.linked,
        local: yield* seedTargetGlobalFlags.local,
        projectRef: leafFlags.projectRef,
      };
      return yield* seedBuckets(flags).pipe(
        withCommandTelemetry({
          flags: {
            remote: flags.remote,
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
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(config),
  withTargetPolicy({ group: "selectable", consent: "no" }),
);
