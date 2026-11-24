import { Command, Flag } from "effect/cli";

import { withTargetPolicy } from "../../../../command-internal/target/target-policy.ts";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../../telemetry/command-telemetry.ts";
import { sparkRuntimeLayer } from "../spark.flags.ts";
import { sparkDevStop } from "./stop.handler.ts";

const config = {
  delete: Flag.Boolean("delete").pipe(
    Flag.withDescription("Delete the dev instance and forget it."),
    Flag.withDefault(false),
  ),
} as const;

export const sparkDevStopCommand = Command.make("stop", config).pipe(
  Command.withDescription(
    "Leaves this checkout's Spark dev instance running; with --delete, deletes it and its state file.",
  ),
  Command.withShortDescription("Stop using the Spark dev instance"),
  Command.withHandler((flags) =>
    sparkDevStop(flags).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling),
  ),
  Command.provide(sparkRuntimeLayer(["stop"])),
  withTargetPolicy({
    group: "account",
    consent: "none",
    consentExemptReason: "--delete removes only this checkout's own dev instance",
  }),
);
