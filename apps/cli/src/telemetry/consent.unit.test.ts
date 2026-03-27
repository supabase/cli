import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { cliConfigLayer } from "../config/cli-config.layer.ts";
import { mockProjectContext, mockRuntimeInfo, processEnvLayer } from "../../tests/helpers/mocks.ts";
import { getEffectiveConsent } from "./consent.ts";
import type { TelemetryConfig } from "./types.ts";

function makeConfig(consent: TelemetryConfig["consent"]): TelemetryConfig {
  return {
    consent,
    device_id: "test-device",
    session_id: "test-session",
    session_last_active: Date.now(),
  };
}

function withEnv(env: Record<string, string>) {
  const runtimeInfoLayer = mockRuntimeInfo();
  const projectContextLayer = mockProjectContext();
  return Layer.mergeAll(
    runtimeInfoLayer,
    projectContextLayer,
    processEnvLayer(env),
    cliConfigLayer.pipe(Layer.provide(runtimeInfoLayer), Layer.provide(projectContextLayer)),
  );
}

function emptyEnv() {
  const runtimeInfoLayer = mockRuntimeInfo();
  const projectContextLayer = mockProjectContext();
  return Layer.mergeAll(
    runtimeInfoLayer,
    projectContextLayer,
    processEnvLayer(),
    cliConfigLayer.pipe(Layer.provide(runtimeInfoLayer), Layer.provide(projectContextLayer)),
  );
}

describe("getEffectiveConsent", () => {
  it.live("returns granted when SUPABASE_TELEMETRY=on", () =>
    Effect.gen(function* () {
      const consent = yield* getEffectiveConsent(null);
      expect(consent).toBe("granted");
    }).pipe(Effect.provide(withEnv({ SUPABASE_TELEMETRY: "on" }))),
  );

  it.live("returns granted when SUPABASE_TELEMETRY=1", () =>
    Effect.gen(function* () {
      const consent = yield* getEffectiveConsent(makeConfig("denied"));
      expect(consent).toBe("granted");
    }).pipe(Effect.provide(withEnv({ SUPABASE_TELEMETRY: "1" }))),
  );

  it.live("returns denied when SUPABASE_TELEMETRY=off", () =>
    Effect.gen(function* () {
      const consent = yield* getEffectiveConsent(makeConfig("granted"));
      expect(consent).toBe("denied");
    }).pipe(Effect.provide(withEnv({ SUPABASE_TELEMETRY: "off" }))),
  );

  it.live("returns denied when SUPABASE_TELEMETRY=0", () =>
    Effect.gen(function* () {
      const consent = yield* getEffectiveConsent(null);
      expect(consent).toBe("denied");
    }).pipe(Effect.provide(withEnv({ SUPABASE_TELEMETRY: "0" }))),
  );

  it.live("returns denied when DO_NOT_TRACK=1", () =>
    Effect.gen(function* () {
      const consent = yield* getEffectiveConsent(makeConfig("granted"));
      expect(consent).toBe("denied");
    }).pipe(Effect.provide(withEnv({ DO_NOT_TRACK: "1" }))),
  );

  it.live("SUPABASE_TELEMETRY=on overrides DO_NOT_TRACK=1", () =>
    Effect.gen(function* () {
      const consent = yield* getEffectiveConsent(null);
      expect(consent).toBe("granted");
    }).pipe(Effect.provide(withEnv({ SUPABASE_TELEMETRY: "on", DO_NOT_TRACK: "1" }))),
  );

  it.live("SUPABASE_TELEMETRY=off takes precedence over DO_NOT_TRACK", () =>
    Effect.gen(function* () {
      const consent = yield* getEffectiveConsent(null);
      expect(consent).toBe("denied");
    }).pipe(Effect.provide(withEnv({ SUPABASE_TELEMETRY: "off", DO_NOT_TRACK: "1" }))),
  );

  it.live("returns config consent value when set", () =>
    Effect.gen(function* () {
      expect(yield* getEffectiveConsent(makeConfig("granted"))).toBe("granted");
      expect(yield* getEffectiveConsent(makeConfig("denied"))).toBe("denied");
    }).pipe(Effect.provide(emptyEnv())),
  );

  it.live("defaults to granted when no config (opt-out model)", () =>
    Effect.gen(function* () {
      const consent = yield* getEffectiveConsent(null);
      expect(consent).toBe("granted");
    }).pipe(Effect.provide(emptyEnv())),
  );
});
