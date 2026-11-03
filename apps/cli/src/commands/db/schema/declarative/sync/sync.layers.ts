import { Layer } from "effect";

import { commandCredentialsLayer } from "../../../../../auth/command-credentials.layer.ts";
import { commandPlatformApiFactoryLayer } from "../../../../../auth/command-platform-api-factory.layer.ts";
import { commandSettingsLayer } from "../../../../../config/command-settings.layer.ts";
import { commandRuntimeLayer } from "../../../../../shared/runtime/command-runtime.layer.ts";
import { stdinLayer } from "../../../../../shared/runtime/stdin.layer.ts";
import { debugLoggerLayer } from "../../../../../command-internal/debug-logger.layer.ts";
import { identityStitchLayer } from "../../../../../command-internal/identity-stitch.ts";
import { telemetryStateLayer } from "../../../../../telemetry/telemetry-state.layer.ts";
import {
  pgDeltaCommandRuntimeLayer,
  pgDeltaDbConfigRuntimeLayer,
} from "../../../../../command-internal/pgdelta-engine-runtime.layer.ts";

const cliSettings = commandSettingsLayer.pipe(Layer.provide(debugLoggerLayer));
const credentials = commandCredentialsLayer.pipe(
  Layer.provide(cliSettings),
  Layer.provide(debugLoggerLayer),
);

// The local-reset bucket seeding statically requires the factory, which resolves its token lazily.
const platformApiFactory = commandPlatformApiFactoryLayer.pipe(
  Layer.provide(credentials),
  Layer.provide(cliSettings),
  Layer.provide(debugLoggerLayer),
  Layer.provide(identityStitchLayer),
);

export const dbSchemaDeclarativeSyncRuntimeLayer = Layer.mergeAll(
  pgDeltaDbConfigRuntimeLayer,
  pgDeltaCommandRuntimeLayer,
  identityStitchLayer,
  telemetryStateLayer,
  platformApiFactory,
  commandRuntimeLayer(["db", "schema", "declarative", "sync"]),
  stdinLayer,
);
