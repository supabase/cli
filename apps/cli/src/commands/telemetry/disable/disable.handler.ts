import { Effect } from "effect";
import { Output } from "../../../shared/output/output.service.ts";
import { setTelemetryEnabled } from "../../../telemetry/telemetry-state.layer.ts";
import type { TelemetryDisableFlags } from "./disable.command.ts";

export const telemetryDisable = Effect.fn("telemetry.disable")(function* (
  _flags: TelemetryDisableFlags,
) {
  const output = yield* Output;
  yield* setTelemetryEnabled(false);
  yield* output.raw("Telemetry is disabled.\n");
});
