import { Effect } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyTelemetryDisableFlags } from "./disable.command.ts";

export const legacyTelemetryDisable = Effect.fn("legacy.telemetry.disable")(function* (
  _flags: LegacyTelemetryDisableFlags,
) {
  const proxy = yield* LegacyGoProxy;
  yield* proxy.exec(["telemetry", "disable"]);
});
