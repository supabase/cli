import { Layer } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { legacyCliConfigLayer } from "../../config/legacy-cli-config.layer.ts";
import { legacyDebugLoggerLayer } from "../../shared/legacy-debug-logger.layer.ts";
import { LEGACY_RESOURCE_OUTPUT_FORMATS } from "../../shared/legacy-go-output-flag.ts";
import { legacyStringSliceFlag } from "../../shared/legacy-string-slice-flag.ts";
import { legacyTelemetryStateLayer } from "../../telemetry/legacy-telemetry-state.layer.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { withLegacyCommandInstrumentation } from "../../telemetry/legacy-command-instrumentation.ts";
import { legacyStatus } from "./status.handler.ts";

// Go registers both `--override-name` and `--exclude` as pflag `StringSliceVar`
// (`cmd/status.go:38-39`), which CSV-splits each occurrence and accumulates
// across repeats — `--override-name a=1,b=2` is two overrides, not one.
// Malformed CSV fails at parse time with pflag's exact diagnostic (CLI-2005,
// see `legacyStringSliceFlag`).
export const legacyStatusOverrideNameFlag = legacyStringSliceFlag(
  "override-name",
  "Override specific variable names.",
);

export const legacyStatusExcludeFlag = legacyStringSliceFlag(
  "exclude",
  "Names of containers to omit from output.",
).pipe(Flag.withHidden);

const config = {
  overrideName: legacyStatusOverrideNameFlag,
  exclude: legacyStatusExcludeFlag,
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
