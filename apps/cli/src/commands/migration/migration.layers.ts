import { Layer } from "effect";

import { httpClientLayer } from "../../auth/http-debug.layer.ts";
import { commandRuntimeLayer } from "../../shared/runtime/command-runtime.layer.ts";
import { stdinLayer } from "../../shared/runtime/stdin.layer.ts";
import { commandSettingsLayer } from "../../config/command-settings.layer.ts";
import { dbConfigLayer } from "../../command-internal/db-config.layer.ts";
import { dbConnectionLayer } from "../../command-internal/db-connection.layer.ts";
import { debugLoggerLayer } from "../../command-internal/debug-logger.layer.ts";
import { dockerRunLayer } from "../../command-internal/docker-run.layer.ts";
import { identityStitchLayer } from "../../command-internal/identity-stitch.ts";
import { linkedDbResolverRuntimeLayer } from "../../command-internal/management-api-runtime.layer.ts";
import { telemetryStateLayer } from "../../telemetry/telemetry-state.layer.ts";

const cliSettings = commandSettingsLayer.pipe(Layer.provide(debugLoggerLayer));

/**
 * Runtime layer for `supabase migration new`. The leanest of the migration
 * runtimes: no DB connection, no Management API, no Docker. Just the resolved CLI
 * config (for `--workdir`), telemetry-state flush, piped stdin, and the command
 * runtime span. `Output`, `Analytics`, `Stdio`, `FileSystem`, `Path`, `Clock`,
 * and `Tty` come from the root layer.
 */
export const migrationNewRuntimeLayer = Layer.mergeAll(
  cliSettings,
  telemetryStateLayer,
  stdinLayer,
  commandRuntimeLayer(["migration", "new"]),
);

const dbConfig = dbConfigLayer.pipe(
  Layer.provide(cliSettings),
  Layer.provide(dbConnectionLayer),
  Layer.provide(debugLoggerLayer),
  Layer.provide(identityStitchLayer),
);

/**
 * Runtime layer for the DB-touching migration subcommands (`list` / `fetch` /
 * `repair` / `up` / `down`). Mirrors `pull.layers.ts` minus the
 * pg-delta / migra stack (no Docker, edge-runtime, SSL probe, or shadow seam):
 * the db-config resolver + connection, the lazy linked-resolver auth stack
 * (project-ref + linked-project cache), the shared identity stitcher, telemetry
 * flush, piped stdin (for the migration confirm prompt, which reads
 * stdin), and the command runtime span. `Output`, `Analytics`, `Stdio`,
 * `FileSystem`, `Path`, `Clock`, `Tty`, and `YesFlag` come from the root.
 *
 * `identityStitchLayer` is provided by the SAME reference to `dbConfig` and
 * the linked resolver so Effect memoises one shared identity-stitch attempt
 * (CLAUDE.md invariant 5).
 */
export const migrationDbRuntimeLayer = (commandPath: ReadonlyArray<string>) =>
  Layer.mergeAll(
    dbConfig,
    dbConnectionLayer,
    cliSettings,
    identityStitchLayer,
    telemetryStateLayer,
    stdinLayer,
    linkedDbResolverRuntimeLayer(commandPath).pipe(Layer.provide(identityStitchLayer)),
    commandRuntimeLayer(commandPath),
  );

const httpClient = httpClientLayer.pipe(Layer.provide(debugLoggerLayer));

/**
 * Runtime layer for `supabase migration squash` — `migrationDbRuntimeLayer`'s bundle
 * plus the three services only squash needs: `DockerRun` (the `pg_dump` one-shot
 * container + the shadow's PG15+ one-shot setup jobs), `HttpClient` (the native shadow's
 * health-check wait), and `DebugLogger` (used on the
 * `LoadLocalVersions` fallback). `ChildProcessSpawner`/`RuntimeInfo`/`Tty`/`FileSystem`/
 * `Path` come from the root layer, same as `db diff`.
 */
export const migrationSquashRuntimeLayer = Layer.mergeAll(
  migrationDbRuntimeLayer(["migration", "squash"]),
  dockerRunLayer,
  httpClient,
  debugLoggerLayer,
);
