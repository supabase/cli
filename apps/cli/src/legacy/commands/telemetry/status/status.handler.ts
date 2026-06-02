import { Effect } from "effect";
import { Output } from "../../../../shared/output/output.service.ts";
import { loadOrCreateLegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.layer.ts";
import type { LegacyTelemetryStatusFlags } from "./status.command.ts";

export const legacyTelemetryStatus = Effect.fn("legacy.telemetry.status")(function* (
  _flags: LegacyTelemetryStatusFlags,
) {
  const output = yield* Output;
  const state = yield* loadOrCreateLegacyTelemetryState();
  yield* output.raw(`Telemetry is ${state.enabled ? "enabled" : "disabled"}.\n`);
});
