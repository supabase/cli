import { Layer } from "effect";

import { commandRuntimeLayer } from "../../../../shared/runtime/command-runtime.layer.ts";
import { legacyCredentialsLayer } from "../../../auth/legacy-credentials.layer.ts";
import { legacyHttpClientLayer } from "../../../auth/legacy-http-debug.layer.ts";
import { legacyPlatformApiFactoryLayer } from "../../../auth/legacy-platform-api-factory.layer.ts";
import { legacyCliSettingsLayer } from "../../../config/legacy-cli-settings.layer.ts";
import { legacyProjectRefLayer } from "../../../config/legacy-project-ref.layer.ts";
import { legacyDbConfigLayer } from "../../../shared/legacy-db-config.layer.ts";
import { legacyDbConnectionLayer } from "../../../shared/legacy-db-connection.layer.ts";
import { legacyDebugLoggerLayer } from "../../../shared/legacy-debug-logger.layer.ts";
import { legacyDockerRunLayer } from "../../../shared/legacy-docker-run.layer.ts";
import { legacyEdgeRuntimeScriptLayer } from "../../../shared/legacy-edge-runtime-script.layer.ts";
import { legacyPgDeltaSslProbeLayer } from "../../../shared/legacy-pgdelta-ssl-probe.layer.ts";
import { stdinLayer } from "../../../../shared/runtime/stdin.layer.ts";
import { legacyIdentityStitchLayer } from "../../../shared/legacy-identity-stitch.ts";
import { legacyLinkedProjectCacheLayer } from "../../../telemetry/legacy-linked-project-cache.layer.ts";
import { legacyTelemetryStateLayer } from "../../../telemetry/legacy-telemetry-state.layer.ts";

/**
 * Runtime layer for `supabase db reset`. Same composition as `db push` / `db lint`:
 * the Postgres connection, the db-config resolver, project-ref resolution, and the
 * linked-project cache, all over the lazy management-API factory so the local /
 * `--db-url` paths never resolve an access token at layer-build time. Both targets
 * are fully native (the local container-recreate primitives, and the remote
 * `--experimental` schema-files apply) — no Go delegation remains on this
 * command, so `LegacyGoProxy` is not composed here.
 *
 * `legacyDockerRunLayer` backs the native local recreate's PG15+ one-shot migrate
 * jobs (`legacyStartSetupLocalDatabase`, reused via `legacyRecreateLocalDatabase`)
 * — same reasoning as `db start`'s own `start.layers.ts`.
 * `legacyEdgeRuntimeScriptLayer`/`legacyPgDeltaSslProbeLayer` back that same shared
 * setup pipeline's best-effort pg-delta migrations-catalog warmup (`db-setup.ts`'s
 * `legacyTryCacheMigrationsCatalog` call, reachable from `db reset`'s PG15 recreate
 * too) AND the remote path's own post-reset catalog-cache call — the exact same
 * pair `db start`/`db push` already compose for their own calls to that function
 * (`db/start/start.layers.ts`, `push.layers.ts`). Without them, a versionless reset
 * with pg-delta enabled would hit an unhandled missing-service defect — not caught
 * by the handler's typed `Effect.catch` — AFTER the database has already been
 * reset, instead of writing the catalog or emitting the established best-effort
 * warning (review CLI-1958). `LegacyCliSettings`/`ChildProcessSpawner`/`FileSystem`/`Path`/
 * `RuntimeInfo` are ambient from the root runtime (`shared/cli/run.ts`).
 */
const cliSettings = legacyCliSettingsLayer.pipe(Layer.provide(legacyDebugLoggerLayer));
const httpClient = legacyHttpClientLayer.pipe(Layer.provide(legacyDebugLoggerLayer));
const edgeRuntime = legacyEdgeRuntimeScriptLayer.pipe(
  Layer.provide(legacyDockerRunLayer),
  Layer.provide(cliSettings),
);
const credentials = legacyCredentialsLayer.pipe(
  Layer.provide(cliSettings),
  Layer.provide(legacyDebugLoggerLayer),
);

const platformApiFactory = legacyPlatformApiFactoryLayer.pipe(
  Layer.provide(credentials),
  Layer.provide(cliSettings),
  Layer.provide(legacyDebugLoggerLayer),
  Layer.provide(legacyIdentityStitchLayer),
);

const projectRef = legacyProjectRefLayer.pipe(
  Layer.provide(platformApiFactory),
  Layer.provide(cliSettings),
);

const linkedProjectCache = legacyLinkedProjectCacheLayer.pipe(
  Layer.provide(credentials),
  Layer.provide(cliSettings),
  Layer.provide(httpClient),
  Layer.provide(legacyIdentityStitchLayer),
);

const dbConfig = legacyDbConfigLayer.pipe(
  Layer.provide(cliSettings),
  Layer.provide(legacyDbConnectionLayer),
  Layer.provide(legacyDebugLoggerLayer),
  Layer.provide(legacyIdentityStitchLayer),
);

export const legacyDbResetRuntimeLayer = Layer.mergeAll(
  dbConfig,
  legacyDbConnectionLayer,
  cliSettings,
  httpClient,
  credentials,
  projectRef,
  // Exposed (not just provided to `projectRef`) because the local reset path reuses
  // the seed-buckets core, whose `legacyResolveStorageCredentials` requires the
  // (lazy) Management-API factory for the linked branch — never hit on `--local`,
  // but a static service requirement of the shared core.
  platformApiFactory,
  linkedProjectCache,
  legacyIdentityStitchLayer,
  legacyTelemetryStateLayer,
  // `legacyPromptYesNo`'s non-TTY branch reads the piped answer via `Stdin`;
  // without it a CI/piped remote `db reset` that reaches the confirmation
  // prompt fails with a missing-service defect instead of the default.
  stdinLayer,
  // Backs the native local recreate's PG15+ one-shot migrate jobs, and the remote
  // path's own post-reset pg-delta catalog-cache call.
  legacyDockerRunLayer,
  edgeRuntime,
  legacyPgDeltaSslProbeLayer,
  commandRuntimeLayer(["db", "reset"]),
);
