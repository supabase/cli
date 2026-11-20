import { Layer } from "effect";
import { Command } from "effect/cli";

import { cliConfigValuesLayer } from "../../../../../config/cli-config-values.layer.ts";
import { withCliConfigFlags } from "../../../../../config/cli-config-flags.ts";
import { commandSettingsLayer } from "../../../../../config/command-settings.layer.ts";
import { debugLoggerLayer } from "../../../../../command-internal/debug-logger.layer.ts";
import { stackApiLayer } from "../../../../../command-internal/stack-api.ts";
import { withJsonErrorHandling } from "../../../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../../../shared/runtime/command-runtime.layer.ts";
import { withCommandTelemetry } from "../../../../../telemetry/command-telemetry.ts";
import { telemetryStateLayer } from "../../../../../telemetry/telemetry-state.layer.ts";
import { sparkDbReset } from "./reset.handler.ts";
import { sparkStackLayer } from "../../spark-stack.ts";

export const sparkDbResetCommand = Command.make("reset", {}).pipe(
  Command.withDescription(
    "Rebuilds the local Spark stack's database from migrations and seed files.",
  ),
  Command.withShortDescription("Resets the local Spark database"),
  Command.withHandler(() => sparkDbReset.pipe(withCommandTelemetry(), withJsonErrorHandling)),
  Command.provide(
    Layer.mergeAll(
      sparkStackLayer.pipe(Layer.provide(stackApiLayer)),
      telemetryStateLayer,
      commandRuntimeLayer(["db", "reset"]),
    ).pipe(Layer.provideMerge(commandSettingsLayer.pipe(Layer.provide(debugLoggerLayer)))),
  ),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags({}),
);
