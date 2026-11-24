import { Command } from "effect/cli";

import { withTargetPolicy } from "../../../../../command-internal/target/target-policy.ts";
import { withJsonErrorHandling } from "../../../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../../../telemetry/command-telemetry.ts";
import { sparkDbPush } from "./push.handler.ts";
import { sparkRuntimeLayer, sparkTargetFlags, withSparkTargetHelp } from "../../spark.flags.ts";

const config = { ...sparkTargetFlags() } as const;

export const sparkDbPushCommand = Command.make("push", config).pipe(
  Command.withDescription(
    "Dry-runs each pending migration on Spark, then applies it with its local version.",
  ),
  Command.withShortDescription("Pushes new migrations to the Spark project"),
  Command.withHandler((flags) =>
    sparkDbPush(flags).pipe(withCommandTelemetry(), withJsonErrorHandling),
  ),
  Command.provide(sparkRuntimeLayer(["db", "push"])),
  withTargetPolicy({ group: "selectable", consent: "no" }),
  withSparkTargetHelp,
);
