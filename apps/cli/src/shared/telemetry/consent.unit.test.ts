import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Clock, ConfigProvider, Effect, FileSystem, Layer, Option, Path, Schema } from "effect";
import { cliSettingsLayer } from "../config/cli-settings.layer.ts";
import { useTempWorkdir } from "../../../tests/helpers/command-mocks.ts";
import { mockCliProjectContext, mockRuntimeInfo } from "../../../tests/helpers/mocks.ts";
import { getEffectiveConsent, readTelemetryConfig } from "./consent.ts";
import type { TelemetryConfig } from "./types.ts";

const makeConfig = (consent: TelemetryConfig["consent"]) =>
  Effect.map(Clock.currentTimeMillis, (now): TelemetryConfig => ({
    consent,
    device_id: "test-device",
    session_id: "test-session",
    session_last_active: now,
  }));

function withEnv(env: Record<string, string>) {
  return cliSettingsLayer.pipe(
    Layer.provide(mockRuntimeInfo()),
    Layer.provide(mockCliProjectContext()),
    Layer.provide(
      ConfigProvider.layer(ConfigProvider.fromEnvRecord(env, { preserveEmptyStrings: true })),
    ),
    Layer.provide(BunServices.layer),
  );
}

function emptyEnv() {
  return withEnv({});
}

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const writeTelemetryFile = (dir: string, content: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.writeFileString(path.join(dir, "telemetry.json"), content);
  });

describe("getEffectiveConsent", () => {
  it.effect("returns denied when DO_NOT_TRACK=1", () =>
    Effect.gen(function* () {
      const consent = yield* getEffectiveConsent(Option.some(yield* makeConfig("granted")));
      expect(consent).toBe("denied");
    }).pipe(Effect.provide(withEnv({ DO_NOT_TRACK: "1" }))),
  );

  it.effect("returns denied when SUPABASE_TELEMETRY_DISABLED=1", () =>
    Effect.gen(function* () {
      const consent = yield* getEffectiveConsent(Option.some(yield* makeConfig("granted")));
      expect(consent).toBe("denied");
    }).pipe(Effect.provide(withEnv({ SUPABASE_TELEMETRY_DISABLED: "1" }))),
  );

  it.effect("SUPABASE_TELEMETRY_DISABLED=1 takes precedence over persisted granted consent", () =>
    Effect.gen(function* () {
      const consent = yield* getEffectiveConsent(Option.none());
      expect(consent).toBe("denied");
    }).pipe(Effect.provide(withEnv({ SUPABASE_TELEMETRY_DISABLED: "1" }))),
  );

  it.effect("DO_NOT_TRACK=1 takes precedence over persisted granted consent", () =>
    Effect.gen(function* () {
      const consent = yield* getEffectiveConsent(Option.some(yield* makeConfig("granted")));
      expect(consent).toBe("denied");
    }).pipe(Effect.provide(withEnv({ DO_NOT_TRACK: "1" }))),
  );

  it.effect("SUPABASE_TELEMETRY_DISABLED=1 takes precedence over DO_NOT_TRACK=1", () =>
    Effect.gen(function* () {
      const consent = yield* getEffectiveConsent(Option.some(yield* makeConfig("granted")));
      expect(consent).toBe("denied");
    }).pipe(Effect.provide(withEnv({ SUPABASE_TELEMETRY_DISABLED: "1", DO_NOT_TRACK: "1" }))),
  );

  it.effect("returns config consent value when set", () =>
    Effect.gen(function* () {
      expect(yield* getEffectiveConsent(Option.some(yield* makeConfig("granted")))).toBe("granted");
      expect(yield* getEffectiveConsent(Option.some(yield* makeConfig("denied")))).toBe("denied");
    }).pipe(Effect.provide(emptyEnv())),
  );

  it.effect("defaults to granted when no config (opt-out model)", () =>
    Effect.gen(function* () {
      const consent = yield* getEffectiveConsent(Option.none());
      expect(consent).toBe("granted");
    }).pipe(Effect.provide(emptyEnv())),
  );
});

describe("readTelemetryConfig", () => {
  const tempRoot = useTempWorkdir("supabase-consent-test-");

  it.effect("decodes a valid telemetry config", () =>
    Effect.gen(function* () {
      const dir = tempRoot.current;
      const expected = yield* makeConfig("denied");
      yield* writeTelemetryFile(dir, yield* encodeJson(expected));

      const config = yield* readTelemetryConfig(dir);
      expect(config).toEqual(Option.some(expected));
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("decodes a legacy disabled telemetry state as denied consent", () =>
    Effect.gen(function* () {
      const dir = tempRoot.current;
      yield* writeTelemetryFile(
        dir,
        yield* encodeJson({
          enabled: false,
          device_id: "legacy-device",
          session_id: "legacy-session",
          session_last_active: "2026-04-01T12:00:00Z",
          schema_version: 1,
        }),
      );

      const config = yield* readTelemetryConfig(dir);
      expect(config).toEqual(
        Option.some({
          consent: "denied",
          device_id: "legacy-device",
          session_id: "legacy-session",
          session_last_active: Date.parse("2026-04-01T12:00:00Z"),
        }),
      );
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("decodes a legacy enabled telemetry state as granted consent", () =>
    Effect.gen(function* () {
      const dir = tempRoot.current;
      yield* writeTelemetryFile(
        dir,
        yield* encodeJson({
          enabled: true,
          device_id: "legacy-device",
          session_id: "legacy-session",
          session_last_active: "2026-04-01T12:00:00Z",
          distinct_id: "user-123",
          schema_version: 1,
        }),
      );

      const config = yield* readTelemetryConfig(dir);
      expect(config).toEqual(
        Option.some({
          consent: "granted",
          device_id: "legacy-device",
          session_id: "legacy-session",
          session_last_active: Date.parse("2026-04-01T12:00:00Z"),
          distinct_id: "user-123",
        }),
      );
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("keeps an overflowed session_last_active and the persisted consent", () =>
    Effect.gen(function* () {
      const dir = tempRoot.current;
      yield* writeTelemetryFile(
        dir,
        '{"consent":"denied","device_id":"device","session_id":"session","session_last_active":1e999}',
      );

      const config = yield* readTelemetryConfig(dir);
      expect(config).toEqual(
        Option.some({
          consent: "denied",
          device_id: "device",
          session_id: "session",
          session_last_active: Infinity,
        }),
      );
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("decodes a legacy state whose schema_version overflowed", () =>
    Effect.gen(function* () {
      const dir = tempRoot.current;
      yield* writeTelemetryFile(
        dir,
        '{"enabled":false,"device_id":"legacy-device","session_id":"legacy-session","session_last_active":"2026-04-01T12:00:00Z","schema_version":1e999}',
      );

      const config = yield* readTelemetryConfig(dir);
      expect(config).toEqual(
        Option.some({
          consent: "denied",
          device_id: "legacy-device",
          session_id: "legacy-session",
          session_last_active: Date.parse("2026-04-01T12:00:00Z"),
        }),
      );
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("returns none for malformed JSON instead of throwing", () =>
    Effect.gen(function* () {
      const dir = tempRoot.current;
      yield* writeTelemetryFile(dir, "");

      const config = yield* readTelemetryConfig(dir);
      expect(config).toEqual(Option.none());
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("returns none for structurally invalid telemetry config", () =>
    Effect.gen(function* () {
      const dir = tempRoot.current;
      yield* writeTelemetryFile(dir, yield* encodeJson({ consent: "granted" }));

      const config = yield* readTelemetryConfig(dir);
      expect(config).toEqual(Option.none());
    }).pipe(Effect.provide(BunServices.layer)),
  );
});
