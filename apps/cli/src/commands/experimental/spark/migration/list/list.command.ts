import { Command } from "effect/cli";

import { withTargetPolicy } from "../../../../../command-internal/target/target-policy.ts";
import { withJsonErrorHandling } from "../../../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../../../telemetry/command-telemetry.ts";
import { sparkMigrationList } from "./list.handler.ts";
import { sparkRuntimeLayer, sparkTargetFlags, withSparkTargetHelp } from "../../spark.flags.ts";

const config = { ...sparkTargetFlags() } as const;

export const sparkMigrationListCommand = Command.make("list", config).pipe(
  Command.withDescription("Lists local migration files and the Spark project's migration history."),
  Command.withShortDescription("List local and remote migrations"),
  Command.withHandler((flags) =>
    sparkMigrationList(flags).pipe(withCommandTelemetry(), withJsonErrorHandling),
  ),
  Command.provide(sparkRuntimeLayer(["migration", "list"])),
  withTargetPolicy({ group: "selectable", consent: "none", consentExemptReason: "read-only" }),
  withSparkTargetHelp,
);
