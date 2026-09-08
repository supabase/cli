import { Effect } from "effect";
import { Output } from "../../../shared/output/output.service.ts";
import { setTelemetryEnabled } from "../../../telemetry/telemetry-state.layer.ts";
import type { TelemetryEnableFlags } from "./enable.command.ts";

export const telemetryEnable = Effect.fn("telemetry.enable")(function* (
  _flags: TelemetryEnableFlags,
) {
  const output = yield* Output;
  yield* setTelemetryEnabled(true);
  yield* output.raw("Telemetry is enabled.\n");
});
