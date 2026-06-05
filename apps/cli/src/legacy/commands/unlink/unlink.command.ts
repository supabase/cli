import { Layer } from "effect";
import { Command } from "effect/unstable/cli";

import { legacyCredentialsLayer } from "../../auth/legacy-credentials.layer.ts";
import { legacyCliConfigLayer } from "../../config/legacy-cli-config.layer.ts";
import { legacyDebugLoggerLayer } from "../../shared/legacy-debug-logger.layer.ts";
import { legacyTelemetryStateLayer } from "../../telemetry/legacy-telemetry-state.layer.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { withLegacyCommandInstrumentation } from "../../telemetry/legacy-command-instrumentation.ts";
import { legacyUnlink } from "./unlink.handler.ts";

// `unlink` makes no Management API calls (Go's unlink needs no access token), so it
// deliberately avoids `legacyManagementApiRuntimeLayer` — that layer eagerly resolves
// an access token and would fail with "Access token not provided" for a token-less
// `unlink`. It provides only the services the handler + instrumentation consume.
// `legacyCliConfigLayer` is provided to credentials AND exposed at the top level
// (Layer.provide does not share to siblings inside a merge — legacy CLAUDE.md item 5).
const cliConfig = legacyCliConfigLayer.pipe(Layer.provide(legacyDebugLoggerLayer));
const credentials = legacyCredentialsLayer.pipe(
  Layer.provide(cliConfig),
  Layer.provide(legacyDebugLoggerLayer),
);

const legacyUnlinkRuntimeLayer = Layer.mergeAll(
  credentials,
  cliConfig,
  legacyTelemetryStateLayer,
  commandRuntimeLayer(["unlink"]),
);

export const legacyUnlinkCommand = Command.make("unlink").pipe(
  Command.withDescription("Unlink a Supabase project."),
  Command.withShortDescription("Unlink a Supabase project"),
  Command.withHandler(() =>
    legacyUnlink().pipe(withLegacyCommandInstrumentation(), withJsonErrorHandling),
  ),
  Command.provide(legacyUnlinkRuntimeLayer),
);
