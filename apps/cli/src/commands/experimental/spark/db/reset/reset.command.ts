import { Layer } from "effect";
import { Command } from "effect/cli";

import { cliConfigValuesLayer } from "../../../../../config/cli-config-values.layer.ts";
import { withCliConfigFlags } from "../../../../../config/cli-config-flags.ts";
import { commandSettingsLayer } from "../../../../../config/command-settings.layer.ts";
import { debugLoggerLayer } from "../../../../../command-internal/debug-logger.layer.ts";
import { stackApiLayer } from "../../../../../command-internal/stack-api.ts";
import { withJsonErrorHandling } from "../../../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../../../telemetry/command-telemetry.ts";
import { sparkDbReset } from "./reset.handler.ts";
import { sparkStackLayer } from "../../spark-stack.ts";
import { sparkRuntimeLayer } from "../../spark.flags.ts";

export const sparkDbResetCommand = Command.make("reset", {}).pipe(
  Command.withDescription(
    "Rebuilds the Spark database from migrations and seed files: the local stack's, or the dev instance's in dev-instance mode.",
  ),
  Command.withShortDescription("Resets the Spark database"),
  Command.withHandler(() => sparkDbReset.pipe(withCommandTelemetry(), withJsonErrorHandling)),
  Command.provide(
    Layer.mergeAll(
      sparkStackLayer.pipe(
        Layer.provide(stackApiLayer),
        Layer.provide(commandSettingsLayer.pipe(Layer.provide(debugLoggerLayer))),
      ),
      sparkRuntimeLayer(["db", "reset"]),
    ),
  ),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags({}),
);
