import { Layer } from "effect";

import { commandCredentialsLayer } from "../../auth/command-credentials.layer.ts";
import { httpClientLayer } from "../../auth/http-debug.layer.ts";
import { commandPlatformApiFactoryFromApiLayer } from "../../auth/command-platform-api-factory.layer.ts";
import { commandPlatformApiLayer } from "../../auth/command-platform-api.layer.ts";
import { commandSettingsLayer } from "../../config/command-settings.layer.ts";
import { projectRefLayer } from "../../config/project-ref.layer.ts";
import { dbConnectionLayer } from "../../command-internal/db-connection.layer.ts";
import { debugLoggerLayer } from "../../command-internal/debug-logger.layer.ts";
import { identityStitchLayer } from "../../command-internal/identity-stitch.ts";
import { linkedProjectCacheLayer } from "../../telemetry/linked-project-cache.layer.ts";
import { telemetryStateLayer } from "../../telemetry/telemetry-state.layer.ts";
import { commandRuntimeLayer } from "../../shared/runtime/command-runtime.layer.ts";
import { browserLayer } from "../../shared/runtime/browser.layer.ts";
import { stdinLayer } from "../../shared/runtime/stdin.layer.ts";
import { loginApiLayer } from "../../command-internal/login-api.layer.ts";
import { loginCryptoLayer } from "../../command-internal/login-crypto.layer.ts";
import { templateServiceLayer } from "./bootstrap.templates.ts";

// `bootstrap` needs the full Management-API stack, the browser-login stack, and the GitHub
// template service. `Layer.provide` doesn't share to siblings inside `Layer.mergeAll` (CLAUDE.md
// invariant 5), so every sub-layer needing `CommandSettings`/`HttpClient`/`CommandCredentials` is
// fed those explicitly; shared sub-layers are memoised by reference so the merge reuses one
// instance of each. `DebugLogger` isn't provided by the root layer, so it's fed here too.
const debugLogger = debugLoggerLayer;
const cliSettings = commandSettingsLayer.pipe(Layer.provide(debugLogger));
const httpClient = httpClientLayer.pipe(Layer.provide(debugLogger));
const credentials = commandCredentialsLayer.pipe(
  Layer.provide(cliSettings),
  Layer.provide(debugLogger),
);
const platformApi = commandPlatformApiLayer.pipe(
  Layer.provide(credentials),
  Layer.provide(cliSettings),
  Layer.provide(httpClient),
  Layer.provide(debugLogger),
  Layer.provide(identityStitchLayer),
);
const platformApiFactory = commandPlatformApiFactoryFromApiLayer.pipe(Layer.provide(platformApi));

export const bootstrapRuntimeLayer = Layer.mergeAll(
  platformApi,
  platformApiFactory,
  httpClient,
  credentials,
  cliSettings,
  projectRefLayer.pipe(Layer.provide(platformApiFactory), Layer.provide(cliSettings)),
  linkedProjectCacheLayer.pipe(
    Layer.provide(credentials),
    Layer.provide(cliSettings),
    Layer.provide(httpClient),
    Layer.provide(identityStitchLayer),
  ),
  telemetryStateLayer,
  dbConnectionLayer,
  // Exposed bare, not just fed to sibling sub-layers, because `bootstrap.handler.ts` calls
  // `resolveLinkedConn` directly and reads it.
  debugLogger,
  // Exposed at top level so `withCommandTelemetry` can read `stitchedDistinctId()` and attribute
  // `cli_command_executed` to the gotrue id. The same reference is provided to
  // platformApi/linkedProjectCache above, so memoisation gives every transport one
  // stitch-attempted guard, aliasing/persisting at most once.
  identityStitchLayer,
  loginApiLayer.pipe(Layer.provide(httpClient), Layer.provide(cliSettings)),
  loginCryptoLayer,
  templateServiceLayer.pipe(Layer.provide(httpClient)),
  browserLayer,
  stdinLayer,
  commandRuntimeLayer(["bootstrap"]),
);
