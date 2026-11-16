import { Effect, Layer } from "effect";

import { removedFlag } from "../../command-internal/removed-command.ts";
import { withJsonErrorHandling } from "../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../shared/runtime/command-runtime.layer.ts";
import { withCommandTelemetry } from "../../telemetry/command-telemetry.ts";
import { telemetryStateLayer } from "../../telemetry/telemetry-state.layer.ts";

/**
 * Rejects the removed `--include-raw-output` on a credential-free runtime:
 * `managementApiRuntimeLayer` resolves the access token eagerly, so building it first would fail
 * with a login error before the removal message.
 */
export const rejectIncludeRawOutput = <Flags extends Record<string, unknown>>(
  command: ReadonlyArray<string>,
  flags: Flags,
) =>
  removedFlag("--include-raw-output", "Use -o json instead.").pipe(
    withCommandTelemetry({ flags }),
    withJsonErrorHandling,
    Effect.provide(Layer.mergeAll(commandRuntimeLayer(command), telemetryStateLayer)),
  );
