import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect, Layer, Option } from "effect";
import { cliConfigLayer } from "../../next/config/cli-config.layer.ts";
import {
  mockProjectContext,
  mockRuntimeInfo,
  processEnvLayer,
} from "../../../tests/helpers/mocks.ts";
import { getEffectiveConsent, readTelemetryConfig } from "./consent.ts";
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

function makeTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "supabase-consent-test-"));
}

function writeTelemetryFile(dir: string, content: string): void {
  writeFileSync(path.join(dir, "telemetry.json"), content);
}

describe("getEffectiveConsent", () => {
  it.live("returns denied when DO_NOT_TRACK=1", () =>
    Effect.gen(function* () {
      const consent = yield* getEffectiveConsent(Option.some(makeConfig("granted")));
      expect(consent).toBe("denied");
    }).pipe(Effect.provide(withEnv({ DO_NOT_TRACK: "1" }))),
  );

  it.live("returns denied when SUPABASE_TELEMETRY_DISABLED=1", () =>
    Effect.gen(function* () {
      const consent = yield* getEffectiveConsent(Option.some(makeConfig("granted")));
      expect(consent).toBe("denied");
    }).pipe(Effect.provide(withEnv({ SUPABASE_TELEMETRY_DISABLED: "1" }))),
  );

  it.live("SUPABASE_TELEMETRY_DISABLED=1 takes precedence over persisted granted consent", () =>
    Effect.gen(function* () {
      const consent = yield* getEffectiveConsent(Option.none());
      expect(consent).toBe("denied");
    }).pipe(Effect.provide(withEnv({ SUPABASE_TELEMETRY_DISABLED: "1" }))),
  );

  it.live("DO_NOT_TRACK=1 takes precedence over persisted granted consent", () =>
    Effect.gen(function* () {
      const consent = yield* getEffectiveConsent(Option.some(makeConfig("granted")));
      expect(consent).toBe("denied");
    }).pipe(Effect.provide(withEnv({ DO_NOT_TRACK: "1" }))),
  );

  it.live("SUPABASE_TELEMETRY_DISABLED=1 takes precedence over DO_NOT_TRACK=1", () =>
    Effect.gen(function* () {
      const consent = yield* getEffectiveConsent(Option.some(makeConfig("granted")));
      expect(consent).toBe("denied");
    }).pipe(Effect.provide(withEnv({ SUPABASE_TELEMETRY_DISABLED: "1", DO_NOT_TRACK: "1" }))),
  );

  it.live("returns config consent value when set", () =>
    Effect.gen(function* () {
      expect(yield* getEffectiveConsent(Option.some(makeConfig("granted")))).toBe("granted");
      expect(yield* getEffectiveConsent(Option.some(makeConfig("denied")))).toBe("denied");
    }).pipe(Effect.provide(emptyEnv())),
  );

  it.live("defaults to granted when no config (opt-out model)", () =>
    Effect.gen(function* () {
      const consent = yield* getEffectiveConsent(Option.none());
      expect(consent).toBe("granted");
    }).pipe(Effect.provide(emptyEnv())),
  );
});

describe("readTelemetryConfig", () => {
  it.live("decodes a valid telemetry config", () => {
    const dir = makeTempDir();
    const expected = makeConfig("denied");
    writeTelemetryFile(dir, JSON.stringify(expected));

    return Effect.gen(function* () {
      const config = yield* readTelemetryConfig(dir);
      expect(config).toEqual(Option.some(expected));
    }).pipe(
      Effect.provide(BunServices.layer),
      Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true }))),
    );
  });

  it.live("returns none for malformed JSON instead of throwing", () => {
    const dir = makeTempDir();
    writeTelemetryFile(dir, "");

    return Effect.gen(function* () {
      const config = yield* readTelemetryConfig(dir);
      expect(config).toEqual(Option.none());
    }).pipe(
      Effect.provide(BunServices.layer),
      Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true }))),
    );
  });

  it.live("returns none for structurally invalid telemetry config", () => {
    const dir = makeTempDir();
    writeTelemetryFile(dir, JSON.stringify({ consent: "granted" }));

    return Effect.gen(function* () {
      const config = yield* readTelemetryConfig(dir);
      expect(config).toEqual(Option.none());
    }).pipe(
      Effect.provide(BunServices.layer),
      Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true }))),
    );
  });
});
