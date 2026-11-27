import { Effect } from "effect";
import { Output } from "../../../shared/output/output.service.ts";
import { TelemetryRuntime } from "../../../shared/telemetry/runtime.service.ts";
import type { TelemetryStatusFlags } from "./status.command.ts";

export const telemetryStatus = Effect.fn("telemetry.status")(function* (
  _flags: TelemetryStatusFlags,
) {
  const output = yield* Output;
  const runtime = yield* TelemetryRuntime;
  const state = runtime.consent === "granted" ? "enabled" : "disabled";
  yield* output.raw(`Telemetry is ${state}.\n`);
});
