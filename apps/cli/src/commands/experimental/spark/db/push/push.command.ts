import { Command } from "effect/cli";

import { managementApiRuntimeLayer } from "../../../../../command-internal/management-api-runtime.layer.ts";
import { withJsonErrorHandling } from "../../../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../../../telemetry/command-telemetry.ts";
import { sparkDbPush } from "./push.handler.ts";
import { projectRef } from "../../spark.flags.ts";

export const sparkDbPushCommand = Command.make("push", { projectRef }).pipe(
  Command.withDescription(
    "Dry-runs each pending migration on Spark, then applies it with its local version.",
  ),
  Command.withShortDescription("Pushes new migrations to the Spark project"),
  Command.withHandler((flags) =>
    sparkDbPush(flags).pipe(withCommandTelemetry(), withJsonErrorHandling),
  ),
  Command.provide(managementApiRuntimeLayer(["db", "push"])),
);
