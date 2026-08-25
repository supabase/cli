import { Layer } from "effect";

import { legacyHttpClientLayer } from "../../auth/legacy-http-debug.layer.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { stdinLayer } from "../../../shared/runtime/stdin.layer.ts";
import { legacyCliSettingsLayer } from "../../config/legacy-cli-settings.layer.ts";
import { legacyDbConfigLayer } from "../../shared/legacy-db-config.layer.ts";
import { legacyDbConnectionLayer } from "../../shared/legacy-db-connection.layer.ts";
import { legacyDebugLoggerLayer } from "../../shared/legacy-debug-logger.layer.ts";
import { legacyDockerRunLayer } from "../../shared/legacy-docker-run.layer.ts";
import { legacyIdentityStitchLayer } from "../../shared/legacy-identity-stitch.ts";
import { legacyLinkedDbResolverRuntimeLayer } from "../../shared/legacy-management-api-runtime.layer.ts";
import { legacyTelemetryStateLayer } from "../../telemetry/legacy-telemetry-state.layer.ts";

const cliSettings = legacyCliSettingsLayer.pipe(Layer.provide(legacyDebugLoggerLayer));

/**
 * Runtime layer for `supabase migration new`. The leanest of the migration
 * runtimes: no DB connection, no Management API, no Docker. Just the resolved CLI
 * config (for `--workdir`), telemetry-state flush, piped stdin, and the command
 * runtime span. `Output`, `Analytics`, `Stdio`, `FileSystem`, `Path`, `Clock`,
 * and `Tty` come from the root layer.
 */
export const legacyMigrationNewRuntimeLayer = Layer.mergeAll(
  cliSettings,
  legacyTelemetryStateLayer,
  stdinLayer,
  commandRuntimeLayer(["migration", "new"]),
);

const dbConfig = legacyDbConfigLayer.pipe(
  Layer.provide(cliSettings),
  Layer.provide(legacyDbConnectionLayer),
  Layer.provide(legacyDebugLoggerLayer),
  Layer.provide(legacyIdentityStitchLayer),
);

/**
 * Runtime layer for the DB-touching migration subcommands (`list` / `fetch` /
 * `repair` / `up` / `down`). Mirrors `pull.layers.ts` minus the
 * pg-delta / migra stack (no Docker, edge-runtime, SSL probe, or shadow seam):
 * the db-config resolver + connection, the lazy linked-resolver auth stack
 * (project-ref + linked-project cache), the shared identity stitcher, telemetry
 * flush, piped stdin (for the migration confirm prompt, which reads
 * stdin), and the command runtime span. `Output`, `Analytics`, `Stdio`,
 * `FileSystem`, `Path`, `Clock`, `Tty`, and `LegacyYesFlag` come from the root.
 *
 * `legacyIdentityStitchLayer` is provided by the SAME reference to `dbConfig` and
 * the linked resolver so Effect memoises one shared identity-stitch attempt
 * (legacy CLAUDE.md rule 5).
 */
export const legacyMigrationDbRuntimeLayer = (commandPath: ReadonlyArray<string>) =>
  Layer.mergeAll(
    dbConfig,
    legacyDbConnectionLayer,
    cliSettings,
    legacyIdentityStitchLayer,
    legacyTelemetryStateLayer,
    stdinLayer,
    legacyLinkedDbResolverRuntimeLayer(commandPath).pipe(Layer.provide(legacyIdentityStitchLayer)),
    commandRuntimeLayer(commandPath),
  );

const httpClient = legacyHttpClientLayer.pipe(Layer.provide(legacyDebugLoggerLayer));

/**
 * Runtime layer for `supabase migration squash` — `legacyMigrationDbRuntimeLayer`'s bundle
 * plus the three services only squash needs: `LegacyDockerRun` (the `pg_dump` one-shot
 * container + the shadow's PG15+ one-shot setup jobs), `HttpClient` (the native shadow's
 * health-check wait), and `LegacyDebugLogger` (used on the
 * `LoadLocalVersions` fallback). `ChildProcessSpawner`/`RuntimeInfo`/`Tty`/`FileSystem`/
 * `Path` come from the root layer, same as `db diff`.
 */
export const legacyMigrationSquashRuntimeLayer = Layer.mergeAll(
  legacyMigrationDbRuntimeLayer(["migration", "squash"]),
  legacyDockerRunLayer,
  httpClient,
  legacyDebugLoggerLayer,
);
