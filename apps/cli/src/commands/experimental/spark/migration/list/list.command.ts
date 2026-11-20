import { Command } from "effect/cli";

import { managementApiRuntimeLayer } from "../../../../../command-internal/management-api-runtime.layer.ts";
import { withJsonErrorHandling } from "../../../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../../../telemetry/command-telemetry.ts";
import { sparkMigrationList } from "./list.handler.ts";
import { projectRef } from "../../spark.flags.ts";

export const sparkMigrationListCommand = Command.make("list", { projectRef }).pipe(
  Command.withDescription("Lists local migration files and the Spark project's migration history."),
  Command.withShortDescription("List local and remote migrations"),
  Command.withHandler((flags) =>
    sparkMigrationList(flags).pipe(withCommandTelemetry(), withJsonErrorHandling),
  ),
  Command.provide(managementApiRuntimeLayer(["migration", "list"])),
);
