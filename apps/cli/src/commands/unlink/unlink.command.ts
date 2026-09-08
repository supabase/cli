import { Layer } from "effect";
import { Command } from "effect/unstable/cli";

import { commandCredentialsLayer } from "../../auth/command-credentials.layer.ts";
import { commandSettingsLayer } from "../../config/command-settings.layer.ts";
import { debugLoggerLayer } from "../../command-internal/debug-logger.layer.ts";
import { telemetryStateLayer } from "../../telemetry/telemetry-state.layer.ts";
import { commandRuntimeLayer } from "../../shared/runtime/command-runtime.layer.ts";
import { withJsonErrorHandling } from "../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../telemetry/command-telemetry.ts";
import { unlink } from "./unlink.handler.ts";

// `unlink` makes no Management API calls (no access token is needed), so it
// deliberately avoids `managementApiRuntimeLayer` — that layer eagerly resolves
// an access token and would fail with "Access token not provided" for a token-less
// `unlink`. It provides only the services the handler + instrumentation consume.
// `commandSettingsLayer` is provided to credentials AND exposed at the top level
// (Layer.provide does not share to siblings inside a merge — legacy CLAUDE.md item 5).
const cliSettings = commandSettingsLayer.pipe(Layer.provide(debugLoggerLayer));
const credentials = commandCredentialsLayer.pipe(
  Layer.provide(cliSettings),
  Layer.provide(debugLoggerLayer),
);

const unlinkRuntimeLayer = Layer.mergeAll(
  credentials,
  cliSettings,
  telemetryStateLayer,
  commandRuntimeLayer(["unlink"]),
);

export const unlinkCommand = Command.make("unlink").pipe(
  Command.withDescription("Unlink a Supabase project."),
  Command.withShortDescription("Unlink a Supabase project"),
  Command.withHandler(() => unlink().pipe(withCommandTelemetry(), withJsonErrorHandling)),
  Command.provide(unlinkRuntimeLayer),
);
