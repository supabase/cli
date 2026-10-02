import { Layer } from "effect";

import { commandCredentialsLayer } from "../../auth/command-credentials.layer.ts";
import { httpClientLayer } from "../../auth/http-debug.layer.ts";
import { commandSettingsLayer } from "../../config/command-settings.layer.ts";
import { debugLoggerLayer } from "../../command-internal/debug-logger.layer.ts";
import { telemetryStateLayer } from "../../telemetry/telemetry-state.layer.ts";
import { commandRuntimeLayer } from "../../shared/runtime/command-runtime.layer.ts";
import { browserLayer } from "../../shared/runtime/browser.layer.ts";
import { stdinLayer } from "../../shared/runtime/stdin.layer.ts";
import { loginApiLayer } from "../../command-internal/login-api.layer.ts";
import { loginCryptoLayer } from "../../command-internal/login-crypto.layer.ts";

// `login` builds its own lean runtime instead of `managementApiRuntimeLayer`, since it must not
// eagerly construct the platform-API client (which fails before a token exists).
//
// `commandSettingsLayer` is shared by reference between `commandCredentialsLayer` and
// `loginApiLayer` (and exposed at the top level) because `Layer.provide` doesn't merge into
// sibling layers — this avoids building two keyring readers / config loaders.
const cliSettings = commandSettingsLayer.pipe(Layer.provide(debugLoggerLayer));
const httpClient = httpClientLayer.pipe(Layer.provide(debugLoggerLayer));
const credentials = commandCredentialsLayer.pipe(
  Layer.provide(cliSettings),
  Layer.provide(debugLoggerLayer),
);
const loginApi = loginApiLayer.pipe(Layer.provide(httpClient), Layer.provide(cliSettings));

export const loginRuntimeLayer = Layer.mergeAll(
  credentials,
  cliSettings,
  httpClient,
  loginApi,
  loginCryptoLayer,
  telemetryStateLayer,
  commandRuntimeLayer(["login"]),
  browserLayer,
  stdinLayer,
);
