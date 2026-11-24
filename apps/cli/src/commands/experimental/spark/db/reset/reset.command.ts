import { Command } from "effect/cli";

import { cliConfigValuesLayer } from "../../../../../config/cli-config-values.layer.ts";
import { withCliConfigFlags } from "../../../../../config/cli-config-flags.ts";
import { withJsonErrorHandling } from "../../../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../../../telemetry/command-telemetry.ts";
import { sparkDbReset } from "./reset.handler.ts";
import { sparkRuntimeLayer } from "../../spark.flags.ts";

export const sparkDbResetCommand = Command.make("reset", {}).pipe(
  Command.withDescription("Rebuilds the dev instance's database from migrations and seed files."),
  Command.withShortDescription("Resets the Spark database"),
  Command.withHandler(() => sparkDbReset.pipe(withCommandTelemetry(), withJsonErrorHandling)),
  Command.provide(sparkRuntimeLayer(["db", "reset"])),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags({}),
);
