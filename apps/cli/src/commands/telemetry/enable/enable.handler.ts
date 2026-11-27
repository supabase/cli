import { Effect } from "effect";
import { Output } from "../../../shared/output/output.service.ts";
import { TelemetryRuntime } from "../../../shared/telemetry/runtime.service.ts";
import { setTelemetryEnabled } from "../../../telemetry/telemetry-state.layer.ts";
import type { TelemetryEnableFlags } from "./enable.command.ts";

export const telemetryEnable = Effect.fn("telemetry.enable")(function* (
  _flags: TelemetryEnableFlags,
) {
  const output = yield* Output;
  const runtime = yield* TelemetryRuntime;
  yield* setTelemetryEnabled(runtime.configDir, true);
  yield* output.raw("Telemetry is enabled.\n");
});
