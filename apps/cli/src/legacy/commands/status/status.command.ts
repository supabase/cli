import { Layer } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { legacyCliConfigLayer } from "../../config/legacy-cli-config.layer.ts";
import { legacyDebugLoggerLayer } from "../../shared/legacy-debug-logger.layer.ts";
import { LEGACY_RESOURCE_OUTPUT_FORMATS } from "../../shared/legacy-go-output-flag.ts";
import { legacyTelemetryStateLayer } from "../../telemetry/legacy-telemetry-state.layer.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { withLegacyCommandInstrumentation } from "../../telemetry/legacy-command-instrumentation.ts";
import { legacyStatus } from "./status.handler.ts";

const config = {
  overrideName: Flag.string("override-name").pipe(
    Flag.atLeast(0),
    Flag.withDescription("Override specific variable names."),
    Flag.withDefault([] as ReadonlyArray<string>),
  ),
  exclude: Flag.string("exclude").pipe(
    Flag.atLeast(0),
    Flag.withDescription("Names of containers to omit from output."),
    Flag.withDefault([] as ReadonlyArray<string>),
    Flag.withHidden,
  ),
  ignoreHealthCheck: Flag.boolean("ignore-health-check").pipe(
    Flag.withDescription("Ignore unhealthy services and exit 0"),
    Flag.withHidden,
  ),
} as const;

export type LegacyStatusFlags = CliCommand.Command.Config.Infer<typeof config>;

// `status` makes no Management API calls (Go's status needs no access token), so
// it deliberately avoids `legacyManagementApiRuntimeLayer` — mirrors `unlink`'s
// runtime shape. `legacyCliConfigLayer` is exposed at the top level directly
// (nothing else in this runtime needs to consume it internally).
const cliConfig = legacyCliConfigLayer.pipe(Layer.provide(legacyDebugLoggerLayer));

const legacyStatusRuntimeLayer = Layer.mergeAll(
  cliConfig,
  legacyTelemetryStateLayer,
  commandRuntimeLayer(["status"]),
);

export const legacyStatusCommand = Command.make("status", config).pipe(
  Command.withDescription("Show status of local Supabase containers."),
  Command.withShortDescription("Show status of local Supabase containers"),
  Command.withExamples([
    {
      command: "supabase status -o env --override-name api.url=NEXT_PUBLIC_SUPABASE_URL",
      description: "Output env vars with custom variable names",
    },
    {
      command: "supabase status -o json",
      description: "Output status as JSON",
    },
  ]),
  Command.withHandler((flags) =>
    legacyStatus(flags).pipe(
      withLegacyCommandInstrumentation({
        flags,
        outputFormats: LEGACY_RESOURCE_OUTPUT_FORMATS,
      }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacyStatusRuntimeLayer),
);
