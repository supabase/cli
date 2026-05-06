import { Effect } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyTelemetryStatusFlags } from "./status.command.ts";

export const legacyTelemetryStatus = Effect.fn("legacy.telemetry.status")(function* (
  _flags: LegacyTelemetryStatusFlags,
) {
  const proxy = yield* LegacyGoProxy;
  yield* proxy.exec(["telemetry", "status"]);
});
