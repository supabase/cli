import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { afterEach, beforeEach } from "vitest";

import { mockAnalytics } from "../../../tests/helpers/mocks.ts";
import { TelemetryRuntime } from "../../shared/telemetry/runtime.service.ts";
import { makeTelemetryIdentity } from "../../shared/telemetry/identity.ts";
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

function makeRuntime(opts: { isCi?: boolean; isFirstRun?: boolean; isTty?: boolean } = {}) {
  const identity = makeTelemetryIdentity(undefined);
  const layer = Layer.succeed(TelemetryRuntime, {
    configDir: "/tmp",
    tracesDir: "/tmp",
    consent: "granted",
    showDebug: false,
    deviceId: "device-xyz",
    sessionId: "session-1",
    identity,
    isFirstRun: opts.isFirstRun ?? false,
    isTty: opts.isTty ?? false,
    isCi: opts.isCi ?? false,
    os: "linux",
    arch: "x64",
    cliVersion: "0.0.0-dev",
  });
  return { layer, identity };
}

function makeLayer(
  analytics: ReturnType<typeof mockAnalytics>,
  runtime: ReturnType<typeof makeRuntime> = makeRuntime(),
) {
  return legacyTelemetryStateLayer.pipe(
    Layer.provide(BunServices.layer),
    Layer.provide(analytics.layer),
    Layer.provide(runtime.layer),
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
  it.effect("stitchLogin in a persistent runtime aliases, persists, and stamps", () => {
    const analytics = mockAnalytics();
    const runtime = makeRuntime();
    return Effect.gen(function* () {
      const state = yield* LegacyTelemetryState;
      yield* state.stitchLogin("gotrue-1");
      expect(analytics.aliased).toEqual([{ distinctId: "gotrue-1", alias: "device-xyz" }]);
      expect(readState().distinct_id).toBe("gotrue-1");
      expect(runtime.identity.current()).toBe("gotrue-1");
    }).pipe(Effect.provide(makeLayer(analytics, runtime)));
  });

  it.effect(
    "stitchLogin in an ephemeral runtime stamps in memory without alias or file write",
    () => {
      const analytics = mockAnalytics();
      const runtime = makeRuntime({ isCi: true });
      return Effect.gen(function* () {
        const state = yield* LegacyTelemetryState;
        yield* state.stitchLogin("gotrue-ci");
        expect(analytics.aliased).toEqual([]);
        expect(existsSync(telemetryPath())).toBe(false);
        expect(runtime.identity.current()).toBe("gotrue-ci");
      }).pipe(Effect.provide(makeLayer(analytics, runtime)));
    },
  );

  it.effect("stitchLogin in a first-run non-tty runtime stamps without alias or file write", () => {
    const analytics = mockAnalytics();
    const runtime = makeRuntime({ isFirstRun: true, isTty: false });
    return Effect.gen(function* () {
      const state = yield* LegacyTelemetryState;
      yield* state.stitchLogin("gotrue-npx");
      expect(analytics.aliased).toEqual([]);
      expect(existsSync(telemetryPath())).toBe(false);
      expect(runtime.identity.current()).toBe("gotrue-npx");
    }).pipe(Effect.provide(makeLayer(analytics, runtime)));
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

  it.effect("stitchLogin with an existing identity persists and stamps without re-aliasing", () => {
    seedState("user-a");
    const analytics = mockAnalytics();
    const runtime = makeRuntime();
    runtime.identity.stamp("user-a");
    return Effect.gen(function* () {
      const state = yield* LegacyTelemetryState;
      yield* state.stitchLogin("user-b");
      expect(analytics.aliased).toEqual([]);
      expect(readState().distinct_id).toBe("user-b");
      expect(runtime.identity.current()).toBe("user-b");
    }).pipe(Effect.provide(makeLayer(analytics, runtime)));
  });

  it.effect("resetIdentity rotates the device id and forgets the user", () => {
    seedState("user-a");
    const analytics = mockAnalytics();
    const runtime = makeRuntime();
    runtime.identity.stamp("user-a");
    return Effect.gen(function* () {
      const state = yield* LegacyTelemetryState;
      yield* state.resetIdentity;
      const next = readState();
      expect(next.distinct_id).toBeUndefined();
      expect(next.device_id).not.toBe("device-xyz");
      expect(runtime.identity.current()).toBeUndefined();
    }).pipe(Effect.provide(makeLayer(analytics, runtime)));
  });

  it.effect(
    "clearDistinctId removes the persisted distinct_id and empties the in-process identity",
    () => {
      seedState("to-clear");
      const analytics = mockAnalytics();
      const runtime = makeRuntime();
      runtime.identity.stamp("to-clear");
      return Effect.gen(function* () {
        const state = yield* LegacyTelemetryState;
        yield* state.clearDistinctId;
        expect(readState().distinct_id).toBeUndefined();
        expect(runtime.identity.current()).toBeUndefined();
      }).pipe(Effect.provide(makeLayer(analytics, runtime)));
    },
  );
});
