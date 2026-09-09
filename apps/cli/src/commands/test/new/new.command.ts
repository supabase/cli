import { Layer } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { commandSettingsLayer } from "../../../config/command-settings.layer.ts";
import { debugLoggerLayer } from "../../../command-internal/debug-logger.layer.ts";
import { telemetryStateLayer } from "../../../telemetry/telemetry-state.layer.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { testNew } from "./new.handler.ts";

const TEMPLATE_VALUES = ["pgtap"] as const;

const config = {
  name: Argument.string("name").pipe(Argument.withDescription("Name of the test file to create.")),
  template: Flag.choice("template", TEMPLATE_VALUES).pipe(
    Flag.withAlias("t"),
    Flag.withDescription("Template framework to generate."),
    Flag.optional,
  ),
} as const;

export type TestNewFlags = CliCommand.Command.Config.Infer<typeof config>;

// `test new` writes a local file and makes no Management API calls, so it avoids
// `managementApiRuntimeLayer` (which eagerly resolves an access token).
// `commandSettingsLayer` provides the resolved `workdir`; `Layer.provide` does not
// share to siblings inside a merge, so it is exposed at the top level too.
const cliSettings = commandSettingsLayer.pipe(Layer.provide(debugLoggerLayer));

const testNewRuntimeLayer = Layer.mergeAll(
  cliSettings,
  telemetryStateLayer,
  commandRuntimeLayer(["test", "new"]),
);

export const testNewCommand = Command.make("new", config).pipe(
  Command.withDescription("Create a new test file."),
  Command.withShortDescription("Create a new test file"),
  Command.withHandler((flags) =>
    testNew(flags).pipe(
      withCommandTelemetry({
        flags,
        config,
        // `--template` registers `-t` (Flag.withAlias above); without this,
        // `-t pgtap` never resolves to the canonical `template` name in
        // extractChangedFlagNames, so it wouldn't appear in telemetry at all
        // (Go's pflag.Visit reports the canonical name regardless of shorthand —
        // cmd/root_analytics.go:53-76).
        aliases: { t: "template" },
      }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(testNewRuntimeLayer),
);
