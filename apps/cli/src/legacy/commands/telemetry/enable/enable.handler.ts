import { Effect } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyTelemetryEnableFlags } from "./enable.command.ts";

export const legacyTelemetryEnable = Effect.fn("legacy.telemetry.enable")(function* (
  _flags: LegacyTelemetryEnableFlags,
) {
  const proxy = yield* LegacyGoProxy;
  yield* proxy.exec(["telemetry", "enable"]);
});
