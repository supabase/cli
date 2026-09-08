import { Layer } from "effect";

import { commandCredentialsLayer } from "../../auth/command-credentials.layer.ts";
import { commandSettingsLayer } from "../../config/command-settings.layer.ts";
import { debugLoggerLayer } from "../../command-internal/debug-logger.layer.ts";
import { telemetryStateLayer } from "../../telemetry/telemetry-state.layer.ts";
import { commandRuntimeLayer } from "../../shared/runtime/command-runtime.layer.ts";
import { stdinLayer } from "../../shared/runtime/stdin.layer.ts";

/**
 * Lean runtime for `logout`. Like `unlink`, it must NOT use
 * `managementApiRuntimeLayer` — that layer eagerly builds the platform-API
 * client, which fails with "Access token not provided" when logging out without
 * a token. It provides only what the handler + instrumentation consume.
 *
 * `commandSettingsLayer` is provided to `commandCredentialsLayer` and also exposed
 * at the top level (`Layer.provide` does not share to siblings inside a merge —
 * legacy CLAUDE.md item 5). `Analytics`, `Output`, `Stdio`, `Tty`, `FileSystem`,
 * `Path`, `TelemetryRuntime`, and `YesFlag` come from the root layer;
 * `stdinLayer` (the shared piped-stdin reader for the logout confirm) builds its
 * `Stdin` from the root `Tty`, like the migration runtimes.
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
