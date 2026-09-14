import { Layer } from "effect";

import { commandSettingsLayer } from "../config/command-settings.layer.ts";
import { dbConfigLayer } from "./db-config.layer.ts";
import { dbConnectionLayer } from "./db-connection.layer.ts";
import { dockerRunLayer } from "./docker-run.layer.ts";
import { identityStitchLayer } from "./identity-stitch.ts";
import { debugLoggerLayer } from "./debug-logger.layer.ts";
import { telemetryStateLayer } from "../telemetry/telemetry-state.layer.ts";
import { commandRuntimeLayer } from "../shared/runtime/command-runtime.layer.ts";

/**
 * Runtime layer shared by `supabase test db` and its hidden alias `supabase
 * db test`, both calling this same factory and `runTestDbCommand`.
 *
 * The Management API stack is intentionally not merged here: it resolves an
 * access token eagerly at build, breaking the auth-free `--local`/`--db-url`
 * paths. The `--linked` path provides it lazily inside the resolver
 * (`db-config.layer.ts`). `commandSettingsLayer` is provided to the resolver
 * and exposed at the top level, since `Layer.provide` does not share to merge
 * siblings.
 *
 * `commandPath` must reflect the actual invoked path (`["test", "db"]` or
 * `["db", "test"]`) so the telemetry `command` property and trace span name
 * differ between the two entry points despite sharing one handler.
 */
const cliSettings = commandSettingsLayer.pipe(Layer.provide(debugLoggerLayer));

const dbConfig = dbConfigLayer.pipe(
  Layer.provide(cliSettings),
  Layer.provide(dbConnectionLayer),
  Layer.provide(debugLoggerLayer),
  // The resolver's lazy `--linked` stack snapshots this one per-command IdentityStitch.
  Layer.provide(identityStitchLayer),
);

export const testDbRuntimeLayer = (commandPath: ReadonlyArray<string>) =>
  Layer.mergeAll(
    dbConfig,
    dbConnectionLayer,
    dockerRunLayer,
    cliSettings,
    // Exposed at top level so `withCommandTelemetry` can read
    // `stitchedDistinctId()`. The same reference is provided to `dbConfig`
    // above, so the lazy linked stack shares a single stitch attempt.
    identityStitchLayer,
    telemetryStateLayer,
    commandRuntimeLayer(commandPath),
  );
