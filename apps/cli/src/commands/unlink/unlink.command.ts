import { Layer } from "effect";
import { Command } from "effect/cli";

import { commandCredentialsLayer } from "../../auth/command-credentials.layer.ts";
import { commandSettingsLayer } from "../../config/command-settings.layer.ts";
import { debugLoggerLayer } from "../../command-internal/debug-logger.layer.ts";
import { telemetryStateLayer } from "../../telemetry/telemetry-state.layer.ts";
import { commandRuntimeLayer } from "../../shared/runtime/command-runtime.layer.ts";
import { withPermissions } from "../../command-internal/command-permissions/command-permissions.annotation.ts";
import { withJsonErrorHandling } from "../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../telemetry/command-telemetry.ts";
import { unlink } from "./unlink.handler.ts";
import { withTargetPolicy } from "../../command-internal/target/target-policy.ts";

// `unlink` makes no Management API calls, so it avoids `managementApiRuntimeLayer`,
// which eagerly resolves an access token and would fail for a token-less `unlink`.
// `commandSettingsLayer` is exposed at the top level too, since `Layer.provide`
// doesn't share to merge siblings.
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
  Command.withDescription(
    "Remove the link between the local project and its hosted Supabase project. " +
      "Use it before linking to a different project.\n\n" +
      "The command deletes the local `supabase/.temp` directory and the stored database password " +
      "for the linked project. Your access token is left untouched.",
  ),
  Command.withShortDescription("Unlink from the hosted Supabase project"),
  Command.withExamples([
    {
      command: "supabase unlink",
      description: "Unlink the current directory from its hosted project",
    },
  ]),
  withPermissions({ operations: [] }),
  Command.withHandler(() => unlink().pipe(withCommandTelemetry(), withJsonErrorHandling)),
  Command.provide(unlinkRuntimeLayer),
  withTargetPolicy({ group: "local-only", consent: "none" }),
);
