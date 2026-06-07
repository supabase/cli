import { Effect } from "effect";
import { Output } from "../../../../shared/output/output.service.ts";
import { setLegacyTelemetryEnabled } from "../../../telemetry/legacy-telemetry-state.layer.ts";
import type { LegacyTelemetryEnableFlags } from "./enable.command.ts";

export const legacyTelemetryEnable = Effect.fn("legacy.telemetry.enable")(function* (
  _flags: LegacyTelemetryEnableFlags,
) {
  const output = yield* Output;
  yield* setLegacyTelemetryEnabled(true);
  yield* output.raw("Telemetry is enabled.\n");
});
