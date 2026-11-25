import { Layer } from "effect";

import { commandCredentialsLayer } from "../../auth/command-credentials.layer.ts";
import { httpClientLayer } from "../../auth/http-debug.layer.ts";
import { commandPlatformApiFactoryLayer } from "../../auth/command-platform-api-factory.layer.ts";
import { commandSettingsLayer } from "../../config/command-settings.layer.ts";
import { projectRefLayer } from "../../config/project-ref.layer.ts";
import { dbConfigLayer } from "../db-config.layer.ts";
import { dbConnectionLayer } from "../db-connection.sql-pg.layer.ts";
import { debugLoggerLayer } from "../debug-logger.layer.ts";
import { identityStitchLayer } from "../identity-stitch.ts";
import { linkedProjectCacheLayer } from "../../telemetry/linked-project-cache.layer.ts";
import { telemetryStateLayer } from "../../telemetry/telemetry-state.layer.ts";

const cliSettings = commandSettingsLayer.pipe(Layer.provide(debugLoggerLayer));
const httpClient = httpClientLayer.pipe(Layer.provide(debugLoggerLayer));
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

const projectRef = projectRefLayer.pipe(
  Layer.provide(platformApiFactory),
  Layer.provide(cliSettings),
);

const linkedProjectCache = linkedProjectCacheLayer.pipe(
  Layer.provide(credentials),
  Layer.provide(cliSettings),
  Layer.provide(httpClient),
  Layer.provide(identityStitchLayer),
);

const dbConfig = dbConfigLayer.pipe(
  Layer.provide(cliSettings),
  Layer.provide(dbConnectionLayer),
  Layer.provide(debugLoggerLayer),
  Layer.provide(identityStitchLayer),
);

export const advisorChecksRuntimeLayer = Layer.mergeAll(
  dbConfig,
  dbConnectionLayer,
  cliSettings,
  httpClient,
  credentials,
  projectRef,
  linkedProjectCache,
  platformApiFactory,
  identityStitchLayer,
  telemetryStateLayer,
);
