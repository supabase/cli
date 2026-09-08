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

// `login` is the only command that writes the access token, so it builds its own
// lean runtime instead of `managementApiRuntimeLayer` — it must NOT eagerly
// construct the platform-API client (which fails when no token exists yet).
//
// `commandSettingsLayer` is provided to both `commandCredentialsLayer` and
// `loginApiLayer`, and exposed at the top level for the handler's direct
// `CommandSettings` reads. `Layer.provide` does not share to siblings inside a
// `Layer.mergeAll` (legacy CLAUDE.md item 5), so the shared sub-layers are
// memoised by reference to avoid building two keyring readers / config loaders.
// `Analytics`, `Output`, `Stdio`, `Tty`, `TelemetryRuntime`, `FileSystem`, and
// `Path` come from the root layer.
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
