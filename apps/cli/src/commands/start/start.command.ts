import { Layer } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { commandRuntimeLayer } from "../../shared/runtime/command-runtime.layer.ts";
import { withJsonErrorHandling } from "../../shared/output/json-error-handling.ts";
import { httpClientLayer } from "../../auth/http-debug.layer.ts";
import { commandSettingsLayer } from "../../config/command-settings.layer.ts";
import { dbConnectionLayer } from "../../command-internal/db-connection.layer.ts";
import { debugLoggerLayer } from "../../command-internal/debug-logger.layer.ts";
import { dockerRunLayer } from "../../command-internal/docker-run.layer.ts";
import { stringSliceFlag } from "../../command-internal/string-slice-flag.ts";
import { telemetryStateLayer } from "../../telemetry/telemetry-state.layer.ts";
import { withCommandTelemetry } from "../../telemetry/command-telemetry.ts";
import { START_EXCLUDABLE_KEYS } from "./start.exclude.ts";
import { start } from "./start.handler.ts";

/**
 * A pflag-style string-slice flag: CSV-splits each occurrence (`--exclude gotrue,realtime` -> two
 * values) and accumulates across repeats, matching `status`'s own `--exclude` handling.
 */
export const startExcludeFlag = stringSliceFlag(
  "exclude",
  `Names of containers to not start. [${START_EXCLUDABLE_KEYS.join(",")}]`,
  { alias: "x" },
);

const config = {
  exclude: startExcludeFlag,
  ignoreHealthCheck: Flag.boolean("ignore-health-check").pipe(
    Flag.withDescription("Ignore unhealthy services and exit 0"),
    Flag.withDefault(false),
  ),
  preview: Flag.boolean("preview").pipe(
    Flag.withDescription("Connect to feature preview branch"),
    Flag.withDefault(false),
    Flag.withHidden,
  ),
} as const;

export type StartFlags = CliCommand.Command.Config.Infer<typeof config>;

// `start` talks directly to Docker with no Management API calls, so it composes its own runtime
// instead of `managementApiRuntimeLayer`. `httpClientLayer` is included explicitly because the
// root runtime doesn't supply `HttpClient.HttpClient`; `dockerRunLayer`/`dbConnectionLayer` back
// the fresh-volume database setup (one-shot migrate jobs plus direct-connection schema SQL).
const cliSettings = commandSettingsLayer.pipe(Layer.provide(debugLoggerLayer));
const httpClient = httpClientLayer.pipe(Layer.provide(debugLoggerLayer));

const startRuntimeLayer = Layer.mergeAll(
  cliSettings,
  telemetryStateLayer,
  commandRuntimeLayer(["start"]),
  dockerRunLayer,
  dbConnectionLayer,
  httpClient,
);

export const startCommand = Command.make("start", config).pipe(
  Command.withDescription("Start containers for Supabase local development."),
  Command.withShortDescription("Start local Supabase stack"),
  Command.withHandler((flags) =>
    start(flags).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling),
  ),
  Command.provide(startRuntimeLayer),
);
