import { Layer } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { commandCredentialsLayer } from "../../auth/command-credentials.layer.ts";
import { commandPlatformApiFactoryLayer } from "../../auth/command-platform-api-factory.layer.ts";
import { commandSettingsLayer } from "../../config/command-settings.layer.ts";
import { debugLoggerLayer } from "../../command-internal/debug-logger.layer.ts";
import { RESOURCE_OUTPUT_FORMATS } from "../../command-internal/go-output-flag.ts";
import { identityStitchLayer } from "../../command-internal/identity-stitch.ts";
import { stringSliceFlag } from "../../command-internal/string-slice-flag.ts";
import { telemetryStateLayer } from "../../telemetry/telemetry-state.layer.ts";
import { commandRuntimeLayer } from "../../shared/runtime/command-runtime.layer.ts";
import { machineErrorContextLayer } from "../../shared/output/machine-error-context.layer.ts";
import { withJsonErrorHandling } from "../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../telemetry/command-telemetry.ts";
import { status } from "./status.handler.ts";

// pflag-style string-slice flags: each occurrence is CSV-split and accumulated across repeats,
// so `--override-name a=1,b=2` is two overrides, not one. Malformed CSV fails at parse time.
export const statusOverrideNameFlag = stringSliceFlag(
  "override-name",
  "Override specific variable names.",
);

export const statusExcludeFlag = stringSliceFlag(
  "exclude",
  "Names of containers to omit from output.",
).pipe(Flag.withHidden);

const config = {
  overrideName: statusOverrideNameFlag,
  exclude: statusExcludeFlag,
  ignoreHealthCheck: Flag.boolean("ignore-health-check").pipe(
    Flag.withDescription("Ignore unhealthy services and exit 0"),
    Flag.withHidden,
    Flag.withDefault(false),
  ),
} as const;

export type StatusFlags = CliCommand.Command.Config.Infer<typeof config>;

// `status` makes no Management API calls, so it avoids `managementApiRuntimeLayer` — the eager
// `CommandPlatformApi` stack that resolves a token at layer build time and fails outright
// without one.
const cliSettings = commandSettingsLayer.pipe(Layer.provide(debugLoggerLayer));

// Lazy Management API handle for `resolveLinkedState`'s best-effort branch-name lookup:
// `commandPlatformApiFactoryLayer` defers token resolution to the first `factory.make` call, so
// its layer build never fails without a token, and provides `IdentityStitch` for response stitching.
const credentials = commandCredentialsLayer.pipe(
  Layer.provide(cliSettings),
  Layer.provide(debugLoggerLayer),
);
const platformApiFactory = commandPlatformApiFactoryLayer.pipe(
  Layer.provide(credentials),
  Layer.provide(cliSettings),
  Layer.provide(debugLoggerLayer),
  Layer.provide(identityStitchLayer),
);

const statusRuntimeLayer = Layer.mergeAll(
  cliSettings,
  platformApiFactory,
  identityStitchLayer,
  telemetryStateLayer,
  machineErrorContextLayer,
  commandRuntimeLayer(["status"]),
);

export const statusCommand = Command.make("status", config).pipe(
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
    status(flags).pipe(
      withCommandTelemetry({
        flags,
        outputFormats: RESOURCE_OUTPUT_FORMATS,
      }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(statusRuntimeLayer),
);
