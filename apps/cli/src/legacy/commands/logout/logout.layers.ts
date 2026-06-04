import { Layer } from "effect";

import { legacyCredentialsLayer } from "../../auth/legacy-credentials.layer.ts";
import { legacyCliConfigLayer } from "../../config/legacy-cli-config.layer.ts";
import { legacyDebugLoggerLayer } from "../../shared/legacy-debug-logger.layer.ts";
import { legacyTelemetryStateLayer } from "../../telemetry/legacy-telemetry-state.layer.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";

/**
 * Lean runtime for `logout`. Like `unlink`, it must NOT use
 * `legacyManagementApiRuntimeLayer` — that layer eagerly builds the platform-API
 * client, which fails with "Access token not provided" when logging out without
 * a token. It provides only what the handler + instrumentation consume.
 *
 * `legacyCliConfigLayer` is provided to `legacyCredentialsLayer` and also exposed
 * at the top level (`Layer.provide` does not share to siblings inside a merge —
 * legacy CLAUDE.md item 5). `Analytics`, `Output`, `Stdio`, `FileSystem`,
 * `Path`, `TelemetryRuntime`, and `LegacyYesFlag` come from the root layer.
 */
const cliConfig = legacyCliConfigLayer.pipe(Layer.provide(legacyDebugLoggerLayer));
const credentials = legacyCredentialsLayer.pipe(
  Layer.provide(cliConfig),
  Layer.provide(legacyDebugLoggerLayer),
);

export const legacyLogoutRuntimeLayer = Layer.mergeAll(
  credentials,
  cliConfig,
  legacyTelemetryStateLayer,
  commandRuntimeLayer(["logout"]),
);
