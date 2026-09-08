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

// `--exclude`/`-x` is a pflag-style string-slice flag, which CSV-splits each
// occurrence (`--exclude gotrue,realtime` -> two values) and accumulates
// across repeats — matching `status`'s own `--exclude`/`--override-name` handling.
// Malformed CSV fails at parse time with pflag's exact diagnostic (CLI-2005); the
// shorthand makes pflag frame it as `"-x, --exclude"` (see `stringSliceFlag`).
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

// `start` makes no Management API calls and talks directly to Docker, so it
// deliberately avoids `managementApiRuntimeLayer` —
// it provides only the services the handler + instrumentation consume, mirroring
// `stop`/`status`'s runtime shape. `ChildProcessSpawner`/`ProcessControl`/`RuntimeInfo`
// are not listed here: they come from `BunServices`/`processControlLayer`/
// `runtimeInfoLayer` in the root runtime (`shared/cli/run.ts`), the same way
// `stop`/`status` rely on the former. `HttpClient.HttpClient` is NOT provided by the
// root runtime — `BunServices.layer` never supplies it, and `httpTransportClientLayer` is a
// different service tag entirely — so it's composed here via `httpClientLayer`,
// the same `FetchHttpClient`-backed layer `db reset`/`seed buckets` use, needed for the
// health-check probes (`waitForHealthyServices`) and `seedBucketsRun`.
// `dockerRunLayer`/`dbConnectionLayer` ARE listed here — the fresh-volume
// `SetupLocalDatabase` equivalent (`start.handler.ts`'s `startSetupLocalDatabase`
// call) needs both: the PG15+ one-shot migrate jobs run through `DockerRun`, and
// the schema/globals/API-privileges SQL runs over a direct `DbConnection` session.
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
