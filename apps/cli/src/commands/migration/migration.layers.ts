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
import { stackApiLayer } from "../experimental/stack/stack.shared.ts";
import { ephemeralPostgresLayer } from "../../command-internal/stack-shadow.ts";

const cliSettings = commandSettingsLayer.pipe(Layer.provide(debugLoggerLayer));

/**
 * Runtime layer for `supabase migration new`: the resolved CLI config, telemetry
 * flush, and piped stdin, with no DB connection, Management API, or Docker.
 * `Output`, `Analytics`, `FileSystem`, `Path`, `Clock`, and `Tty` come from the root.
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
 * `repair` / `up` / `down`).
 *
 * `identityStitchLayer` is provided by the same reference to `dbConfig` and the
 * linked resolver so Effect memoizes one shared identity-stitch attempt.
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
 * Runtime layer for `supabase migration squash`: `migrationDbRuntimeLayer`'s bundle
 * plus `DockerRun` (pg_dump and the shadow's setup jobs), `HttpClient` (the shadow's
 * health-check wait), and `DebugLogger` (the `loadLocalVersions` fallback).
 */
export const migrationSquashRuntimeLayer = Layer.mergeAll(
  migrationDbRuntimeLayer(["migration", "squash"]),
  dockerRunLayer,
  httpClient,
  debugLoggerLayer,
  stackApiLayer,
  ephemeralPostgresLayer,
);
