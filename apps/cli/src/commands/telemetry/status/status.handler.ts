import { Effect } from "effect";
import { Output } from "../../../shared/output/output.service.ts";
import { loadOrCreateTelemetryState } from "../../../telemetry/telemetry-state.layer.ts";
import type { TelemetryStatusFlags } from "./status.command.ts";

export const telemetryStatus = Effect.fn("telemetry.status")(function* (
  _flags: TelemetryStatusFlags,
) {
  const output = yield* Output;
  const state = yield* loadOrCreateTelemetryState();
  yield* output.raw(`Telemetry is ${state.enabled ? "enabled" : "disabled"}.\n`);
});
