import { Effect } from "effect";
import { Output } from "../../../../shared/output/output.service.ts";
import { setLegacyTelemetryEnabled } from "../../../telemetry/legacy-telemetry-state.layer.ts";
import type { LegacyTelemetryDisableFlags } from "./disable.command.ts";

export const legacyTelemetryDisable = Effect.fn("legacy.telemetry.disable")(function* (
  _flags: LegacyTelemetryDisableFlags,
) {
  const output = yield* Output;
  yield* setLegacyTelemetryEnabled(false);
  yield* output.raw("Telemetry is disabled.\n");
});
