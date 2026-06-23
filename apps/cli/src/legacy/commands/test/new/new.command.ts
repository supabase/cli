import { Layer } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { legacyCliConfigLayer } from "../../../config/legacy-cli-config.layer.ts";
import { legacyDebugLoggerLayer } from "../../../shared/legacy-debug-logger.layer.ts";
import { legacyTelemetryStateLayer } from "../../../telemetry/legacy-telemetry-state.layer.ts";
import { commandRuntimeLayer } from "../../../../shared/runtime/command-runtime.layer.ts";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacyTestNew } from "./new.handler.ts";

const TEMPLATE_VALUES = ["pgtap"] as const;

const config = {
  name: Argument.string("name").pipe(Argument.withDescription("Name of the test file to create.")),
  template: Flag.choice("template", TEMPLATE_VALUES).pipe(
    Flag.withAlias("t"),
    Flag.withDescription("Template framework to generate."),
    Flag.optional,
  ),
} as const;

export type LegacyTestNewFlags = CliCommand.Command.Config.Infer<typeof config>;

// `test new` writes a local file and makes no Management API calls, so it avoids
// `legacyManagementApiRuntimeLayer` (which eagerly resolves an access token).
// `legacyCliConfigLayer` provides the resolved `workdir`; `Layer.provide` does not
// share to siblings inside a merge, so it is exposed at the top level too.
const cliConfig = legacyCliConfigLayer.pipe(Layer.provide(legacyDebugLoggerLayer));

const legacyTestNewRuntimeLayer = Layer.mergeAll(
  cliConfig,
  legacyTelemetryStateLayer,
  commandRuntimeLayer(["test", "new"]),
);

export const legacyTestNewCommand = Command.make("new", config).pipe(
  Command.withDescription("Create a new test file."),
  Command.withShortDescription("Create a new test file"),
  Command.withHandler((flags) =>
    legacyTestNew(flags).pipe(withLegacyCommandInstrumentation({ flags }), withJsonErrorHandling),
  ),
  Command.provide(legacyTestNewRuntimeLayer),
);
