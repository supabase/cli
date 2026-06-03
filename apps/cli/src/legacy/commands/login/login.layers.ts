import { Layer } from "effect";

import { legacyCredentialsLayer } from "../../auth/legacy-credentials.layer.ts";
import { legacyHttpClientLayer } from "../../auth/legacy-http-debug.layer.ts";
import { legacyCliConfigLayer } from "../../config/legacy-cli-config.layer.ts";
import { legacyTelemetryStateLayer } from "../../telemetry/legacy-telemetry-state.layer.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { browserLayer } from "../../../shared/runtime/browser.layer.ts";
import { stdinLayer } from "../../../shared/runtime/stdin.layer.ts";
import { legacyLoginApiLayer } from "./login-api.layer.ts";
import { legacyLoginCryptoLayer } from "./login-crypto.layer.ts";

// `login` is the only command that writes the access token, so it builds its own
// lean runtime instead of `legacyManagementApiRuntimeLayer` — it must NOT eagerly
// construct the platform-API client (which fails when no token exists yet).
//
// `legacyCliConfigLayer` is provided to both `legacyCredentialsLayer` and
// `legacyLoginApiLayer`, and exposed at the top level for the handler's direct
// `LegacyCliConfig` reads. `Layer.provide` does not share to siblings inside a
// `Layer.mergeAll` (legacy CLAUDE.md item 5), so the shared sub-layers are
// memoised by reference to avoid building two keyring readers / config loaders.
// `Analytics`, `Output`, `Stdio`, `Tty`, `TelemetryRuntime`, `FileSystem`, and
// `Path` come from the root layer.
const credentials = legacyCredentialsLayer.pipe(Layer.provide(legacyCliConfigLayer));
const loginApi = legacyLoginApiLayer.pipe(
  Layer.provide(legacyHttpClientLayer),
  Layer.provide(legacyCliConfigLayer),
);

export const legacyLoginRuntimeLayer = Layer.mergeAll(
  credentials,
  legacyCliConfigLayer,
  legacyHttpClientLayer,
  loginApi,
  legacyLoginCryptoLayer,
  legacyTelemetryStateLayer,
  commandRuntimeLayer(["login"]),
  browserLayer,
  stdinLayer,
);
