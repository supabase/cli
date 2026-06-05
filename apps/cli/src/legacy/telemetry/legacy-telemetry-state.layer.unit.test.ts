import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { afterEach, beforeEach } from "vitest";

import { mockAnalytics } from "../../../tests/helpers/mocks.ts";
import { TelemetryRuntime } from "../../shared/telemetry/runtime.service.ts";
import { legacyTelemetryStateLayer } from "./legacy-telemetry-state.layer.ts";
import { LegacyTelemetryState } from "./legacy-telemetry-state.service.ts";

let tempHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "supabase-legacy-telemetry-"));
  prevHome = process.env["SUPABASE_HOME"];
  process.env["SUPABASE_HOME"] = tempHome;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env["SUPABASE_HOME"];
  else process.env["SUPABASE_HOME"] = prevHome;
  rmSync(tempHome, { recursive: true, force: true });
});

const runtimeLayer = Layer.succeed(TelemetryRuntime, {
  configDir: "/tmp",
  tracesDir: "/tmp",
  consent: "granted",
  showDebug: false,
  deviceId: "device-xyz",
  sessionId: "session-1",
  isFirstRun: false,
  isTty: false,
  isCi: false,
  os: "linux",
  arch: "x64",
  cliVersion: "0.0.0-dev",
});

function makeLayer(analytics: ReturnType<typeof mockAnalytics>) {
  return legacyTelemetryStateLayer.pipe(
    Layer.provide(BunServices.layer),
    Layer.provide(analytics.layer),
    Layer.provide(runtimeLayer),
  );
}

const telemetryPath = () => join(tempHome, "telemetry.json");
const readState = (): Record<string, unknown> =>
  JSON.parse(readFileSync(telemetryPath(), "utf8")) as Record<string, unknown>;
const seedState = (distinctId?: string) =>
  writeFileSync(
    telemetryPath(),
    JSON.stringify({
      enabled: true,
      device_id: "device-xyz",
      session_id: "session-1",
      session_last_active: new Date().toISOString(),
      ...(distinctId !== undefined ? { distinct_id: distinctId } : {}),
      schema_version: 1,
    }),
  );

describe("legacyTelemetryStateLayer.stitchLogin / clearDistinctId", () => {
  it.effect("stitchLogin aliases the device id and persists the distinct_id", () => {
    const analytics = mockAnalytics();
    return Effect.gen(function* () {
      const state = yield* LegacyTelemetryState;
      yield* state.stitchLogin("gotrue-1");
      expect(analytics.aliased).toEqual([{ distinctId: "gotrue-1", alias: "device-xyz" }]);
      expect(readState().distinct_id).toBe("gotrue-1");
    }).pipe(Effect.provide(makeLayer(analytics)));
  });

  it.effect("stitchLogin replaces a stale distinct_id (parity: stale id is replaced)", () => {
    seedState("stale-id");
    const analytics = mockAnalytics();
    return Effect.gen(function* () {
      const state = yield* LegacyTelemetryState;
      yield* state.stitchLogin("fresh-id");
      expect(readState().distinct_id).toBe("fresh-id");
    }).pipe(Effect.provide(makeLayer(analytics)));
  });

  it.effect("clearDistinctId removes the persisted distinct_id", () => {
    seedState("to-clear");
    const analytics = mockAnalytics();
    return Effect.gen(function* () {
      const state = yield* LegacyTelemetryState;
      yield* state.clearDistinctId;
      expect(readState().distinct_id).toBeUndefined();
    }).pipe(Effect.provide(makeLayer(analytics)));
  });
});
