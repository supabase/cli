import { Command, Flag } from "effect/cli";

import { withTargetPolicy } from "../../../../command-internal/target/target-policy.ts";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../../telemetry/command-telemetry.ts";
import { sparkRuntimeLayer } from "../spark.flags.ts";
import { sparkDevStatus } from "./status.handler.ts";

const config = {
  env: Flag.Boolean("env").pipe(
    Flag.withDescription("Print the URLs and keys as environment variables."),
    Flag.withDefault(false),
  ),
} as const;

export const sparkDevStatusCommand = Command.make("status", config).pipe(
  Command.withDescription(
    "Shows this checkout's Spark dev instance: its name, ref, status, API, REST, Auth and Functions URLs, and anon and service_role keys.",
  ),
  Command.withShortDescription("Show the Spark dev instance"),
  Command.withHandler((flags) =>
    sparkDevStatus(flags).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling),
  ),
  Command.provide(sparkRuntimeLayer(["status"])),
  withTargetPolicy({ group: "account", consent: "none" }),
);
