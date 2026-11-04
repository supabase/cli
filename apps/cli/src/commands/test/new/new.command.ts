import { Layer } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { commandSettingsLayer } from "../../../config/command-settings.layer.ts";
import { debugLoggerLayer } from "../../../command-internal/debug-logger.layer.ts";
import { telemetryStateLayer } from "../../../telemetry/telemetry-state.layer.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { testNew } from "./new.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { cliArgument, cliFlag, makeCommand } from "../../../shared/cli/cli-params.ts";

const TEMPLATE_VALUES = ["pgtap"] as const;

const config = {
  name: cliArgument("name", Argument.String, {
    description: "Name for the new test file; the _test.sql suffix is added.",
    required: true,
  }),
  template: cliFlag("template", (name) => Flag.Literals(name, TEMPLATE_VALUES), {
    description: "Test framework to generate the file for.",
    alias: "t",
    optional: true,
    docs: { default: "pgtap" },
  }),
} as const;

export type TestNewFlags = CliCommand.Command.Config.Infer<typeof config>;

// `test new` writes a local file and makes no Management API calls, so it avoids
// `managementApiRuntimeLayer`. `commandSettingsLayer` (providing `workdir`) is
// exposed at the top level too, since `Layer.provide` doesn't share to merge siblings.
const cliSettings = commandSettingsLayer.pipe(Layer.provide(debugLoggerLayer));

const testNewRuntimeLayer = Layer.mergeAll(
  cliSettings,
  telemetryStateLayer,
  commandRuntimeLayer(["test", "new"]),
);

export const testNewCommand = makeCommand("new", config).pipe(
  Command.withDescription(
    "Create a test file in supabase/tests to start writing database tests from a template.",
  ),
  Command.withShortDescription("Create a new test file"),
  Command.withExamples([
    { command: "supabase test new users", description: "Create a pgTAP test file" },
  ]),
  withPermissions({ operations: [], noApiEffectFlags: ["template"] }),
  Command.withHandler((flags) =>
    testNew(flags).pipe(
      withCommandTelemetry({
        flags,
        config,
        // Without this, `-t pgtap` never resolves to the canonical `template` name in
        // extractChangedFlagNames, so it wouldn't appear in telemetry at all.
        aliases: { t: "template" },
      }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(testNewRuntimeLayer),
  withTargetPolicy({ group: "local-only", consent: "none" }),
);
