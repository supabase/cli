import { Layer } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { legacyCredentialsLayer } from "../../auth/legacy-credentials.layer.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { legacyHttpClientLayer } from "../../auth/legacy-http-debug.layer.ts";
import { legacyPlatformApiFactoryLayer } from "../../auth/legacy-platform-api-factory.layer.ts";
import { legacyCliConfigLayer } from "../../config/legacy-cli-config.layer.ts";
import { legacyDbConnectionLayer } from "../../shared/legacy-db-connection.layer.ts";
import { legacyDebugLoggerLayer } from "../../shared/legacy-debug-logger.layer.ts";
import { legacyDockerRunLayer } from "../../shared/legacy-docker-run.layer.ts";
import { legacyEdgeRuntimeScriptLayer } from "../../shared/legacy-edge-runtime-script.layer.ts";
import { legacyLocalGatewayHttpClientLayer } from "../../shared/legacy-local-gateway-http-client.ts";
import { legacyIdentityStitchLayer } from "../../shared/legacy-identity-stitch.ts";
import { legacyPgDeltaSslProbeLayer } from "../../shared/legacy-pgdelta-ssl-probe.layer.ts";
import { legacyStringSliceFlag } from "../../shared/legacy-string-slice-flag.ts";
import { legacyTelemetryStateLayer } from "../../telemetry/legacy-telemetry-state.layer.ts";
import { withLegacyCommandInstrumentation } from "../../telemetry/legacy-command-instrumentation.ts";
import { stdinLayer } from "../../../shared/runtime/stdin.layer.ts";
import { LEGACY_START_EXCLUDABLE_KEYS } from "./start.exclude.ts";
import { legacyStart } from "./start.handler.ts";

// `--exclude`/`-x` is a pflag-style string-slice flag, which CSV-splits each
// occurrence (`--exclude gotrue,realtime` -> two values) and accumulates
// across repeats — matching `status`'s own `--exclude`/`--override-name` handling.
// Malformed CSV fails at parse time with pflag's exact diagnostic (CLI-2005); the
// shorthand makes pflag frame it as `"-x, --exclude"` (see `legacyStringSliceFlag`).
export const legacyStartExcludeFlag = legacyStringSliceFlag(
  "exclude",
  `Names of containers to not start. [${LEGACY_START_EXCLUDABLE_KEYS.join(",")}]`,
  { alias: "x" },
);

const config = {
  exclude: legacyStartExcludeFlag,
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

export type LegacyStartFlags = CliCommand.Command.Config.Infer<typeof config>;

// `start` makes no eager Management API calls and talks directly to Docker, so it
// deliberately avoids `legacyManagementApiRuntimeLayer` (the eager API stack). It
// does expose the lazy `LegacyPlatformApiFactory` because the shared local-project
// context can take a linked/config interpolation path; constructing that factory
// does not resolve credentials or make a request, and the local Docker path never
// invokes it. The remaining services are the handler + instrumentation runtime,
// mirroring `stop`/`status`'s shape. `ChildProcessSpawner`/`ProcessControl`/`RuntimeInfo`
// are not listed here: they come from `BunServices`/`processControlLayer`/
// `runtimeInfoLayer` in the root runtime (`shared/cli/run.ts`), the same way
// `stop`/`status` rely on the former. `HttpClient.HttpClient` is NOT provided by the
// root runtime — `BunServices.layer` never supplies it, and `httpTransportClientLayer` is a
// different service tag entirely — so it's composed here via `legacyHttpClientLayer`,
// the same `FetchHttpClient`-backed layer `db reset`/`seed buckets` use, needed for the
// health-check probes (`legacyWaitForHealthyServices`) and `legacySeedBucketsRun`.
// `legacyDockerRunLayer`/`legacyDbConnectionLayer` ARE listed here — the fresh-volume
// `SetupLocalDatabase` equivalent (`start.handler.ts`'s `legacyStartSetupLocalDatabase`
// call) needs both: the PG15+ one-shot migrate jobs run through `LegacyDockerRun`, and
// the schema/globals/API-privileges SQL runs over a direct `LegacyDbConnection` session.
// `legacyEdgeRuntimeScriptLayer`/`legacyPgDeltaSslProbeLayer` back that same fresh-volume
// pipeline's best-effort pg-delta migrations-catalog warmup (`db-setup.ts`'s
// `legacyTryCacheMigrationsCatalog` call) — the exact same pair `db push` already composes
// for its own call to that function (`push.layers.ts`).
const cliConfig = legacyCliConfigLayer.pipe(Layer.provide(legacyDebugLoggerLayer));
const httpClient = legacyHttpClientLayer.pipe(Layer.provide(legacyDebugLoggerLayer));
const credentials = legacyCredentialsLayer.pipe(
  Layer.provide(cliConfig),
  Layer.provide(legacyDebugLoggerLayer),
);
const platformApiFactory = legacyPlatformApiFactoryLayer.pipe(
  Layer.provide(credentials),
  Layer.provide(cliConfig),
  Layer.provide(legacyDebugLoggerLayer),
  Layer.provide(legacyIdentityStitchLayer),
);
const edgeRuntime = legacyEdgeRuntimeScriptLayer.pipe(
  Layer.provide(legacyDockerRunLayer),
  Layer.provide(cliConfig),
);

const legacyStartRuntimeLayer = Layer.mergeAll(
  cliConfig,
  legacyTelemetryStateLayer,
  commandRuntimeLayer(["start"]),
  legacyDockerRunLayer,
  legacyDbConnectionLayer,
  httpClient,
  platformApiFactory,
  stdinLayer,
  legacyLocalGatewayHttpClientLayer,
  edgeRuntime,
  legacyPgDeltaSslProbeLayer,
);

export const legacyStartCommand = Command.make("start", config).pipe(
  Command.withDescription("Start containers for Supabase local development."),
  Command.withShortDescription("Start local Supabase stack"),
  Command.withHandler((flags) =>
    legacyStart(flags).pipe(withLegacyCommandInstrumentation({ flags }), withJsonErrorHandling),
  ),
  Command.provide(legacyStartRuntimeLayer),
);
