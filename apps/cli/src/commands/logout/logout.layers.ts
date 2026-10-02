import { Layer } from "effect";

import { commandCredentialsLayer } from "../../auth/command-credentials.layer.ts";
import { commandSettingsLayer } from "../../config/command-settings.layer.ts";
import { debugLoggerLayer } from "../../command-internal/debug-logger.layer.ts";
import { telemetryStateLayer } from "../../telemetry/telemetry-state.layer.ts";
import { commandRuntimeLayer } from "../../shared/runtime/command-runtime.layer.ts";
import { stdinLayer } from "../../shared/runtime/stdin.layer.ts";

/**
 * Lean runtime for `logout`; it must not use `managementApiRuntimeLayer`, which eagerly builds
 * the platform-API client and fails with "Access token not provided" when logging out without
 * a token.
 *
 * `commandSettingsLayer` is provided to `commandCredentialsLayer` and also exposed at the top
 * level, since `Layer.provide` doesn't share to siblings inside a merge.
 */
const cliSettings = commandSettingsLayer.pipe(Layer.provide(debugLoggerLayer));
const credentials = commandCredentialsLayer.pipe(
  Layer.provide(cliSettings),
  Layer.provide(debugLoggerLayer),
);

export const logoutRuntimeLayer = Layer.mergeAll(
  credentials,
  cliSettings,
  telemetryStateLayer,
  commandRuntimeLayer(["logout"]),
  stdinLayer,
);
