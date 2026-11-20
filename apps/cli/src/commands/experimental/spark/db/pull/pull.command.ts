import { Command } from "effect/cli";

import { cliConfigValuesLayer } from "../../../../../config/cli-config-values.layer.ts";
import { withCliConfigFlags } from "../../../../../config/cli-config-flags.ts";
import { withJsonErrorHandling } from "../../../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../../../telemetry/command-telemetry.ts";
import { sparkDbPull } from "./pull.handler.ts";
import { projectRef, schema, shadowRuntimeLayer } from "../../spark.flags.ts";

const pullConfig = { projectRef, schema } as const;

export const sparkDbPullCommand = Command.make("pull", pullConfig).pipe(
  Command.withDescription(
    "Loads the project's dump into a shadow Postgres and exports it to supabase/schemas.",
  ),
  Command.withShortDescription("Pulls the Spark project's schema"),
  Command.withHandler((flags) =>
    sparkDbPull(flags).pipe(
      withCommandTelemetry({ flags: { schema: flags.schema }, aliases: { s: "schema" } }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(shadowRuntimeLayer(["db", "pull"])),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(pullConfig),
);
