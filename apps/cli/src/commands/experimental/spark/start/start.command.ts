import { Command, Flag } from "effect/cli";

import { cliConfigValuesLayer } from "../../../../config/cli-config-values.layer.ts";
import { withCliConfigFlags } from "../../../../config/cli-config-flags.ts";
import { withTargetPolicy } from "../../../../command-internal/target/target-policy.ts";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../../telemetry/command-telemetry.ts";
import { sparkRuntimeLayer } from "../spark.flags.ts";
import { sparkDevStart } from "./start.handler.ts";

const config = {
  org: Flag.String("org").pipe(
    Flag.withDescription(
      "Organization slug to create the dev instance in; defaults to the linked project's, or the only one.",
    ),
    Flag.optional,
  ),
} as const;

export const sparkDevStartCommand = Command.make("start", config).pipe(
  Command.withDescription(
    "Creates or reuses this checkout's Spark dev instance through the Management API, applies the pending migrations, seeds a new instance, and prints its URLs and keys.",
  ),
  Command.withShortDescription("Start the Spark dev instance"),
  Command.withHandler((flags) =>
    sparkDevStart(flags).pipe(withCommandTelemetry(), withJsonErrorHandling),
  ),
  Command.provide(sparkRuntimeLayer(["start"])),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(config),
  withTargetPolicy({
    group: "account",
    consent: "none",
    consentExemptReason: "creates and changes only this checkout's own dev instance",
  }),
);
