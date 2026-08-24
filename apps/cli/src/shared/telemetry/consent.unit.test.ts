import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Clock, Effect, FileSystem, Layer, Option, Path, Schema } from "effect";
import { cliConfigLayer } from "../../next/config/cli-config.layer.ts";
import {
  mockProjectContext,
  mockRuntimeInfo,
  processEnvLayer,
} from "../../../tests/helpers/mocks.ts";
import { getEffectiveConsent, readTelemetryConfig } from "./consent.ts";
import type { TelemetryConfig } from "./types.ts";

const makeConfig = (consent: TelemetryConfig["consent"]) =>
  Effect.map(Clock.currentTimeMillis, (session_last_active): TelemetryConfig => ({
    consent,
    device_id: "test-device",
    session_id: "test-session",
    session_last_active,
  }));

function withEnv(env: Record<string, string>) {
  const runtimeInfoLayer = mockRuntimeInfo();
  const projectContextLayer = mockProjectContext();
  const envLayer = processEnvLayer(env);
  return Layer.mergeAll(
    runtimeInfoLayer,
    projectContextLayer,
    envLayer,
    cliConfigLayer.pipe(
      Layer.provide(runtimeInfoLayer),
      Layer.provide(projectContextLayer),
      Layer.provideMerge(envLayer),
      Layer.provideMerge(BunServices.layer),
    ),
  );
}

function emptyEnv() {
  const runtimeInfoLayer = mockRuntimeInfo();
  const projectContextLayer = mockProjectContext();
  const envLayer = processEnvLayer();
  return Layer.mergeAll(
    runtimeInfoLayer,
    projectContextLayer,
    envLayer,
    cliConfigLayer.pipe(
      Layer.provide(runtimeInfoLayer),
      Layer.provide(projectContextLayer),
      Layer.provideMerge(envLayer),
      Layer.provideMerge(BunServices.layer),
    ),
  );
}

const makeTempDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectory({ prefix: "supabase-consent-test-" });
});

const writeTelemetryFile = (dir: string, content: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.writeFileString(path.join(dir, "telemetry.json"), content);
  });

const encodeJson = (value: unknown): Effect.Effect<string, Schema.SchemaError, never> =>
  Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(value);

const removeTempDir = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(dir, { recursive: true, force: true });
  }).pipe(Effect.ignore);

const withTempDir = <A, E, R>(use: (dir: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const dir = yield* makeTempDir;
    return yield* use(dir).pipe(Effect.ensuring(removeTempDir(dir)));
  }).pipe(Effect.provide(BunServices.layer));

describe("getEffectiveConsent", () => {
  it.live("returns denied when DO_NOT_TRACK=1", () =>
    Effect.gen(function* () {
      const consent = yield* getEffectiveConsent(Option.some(yield* makeConfig("granted")));
      expect(consent).toBe("denied");
    }).pipe(Effect.provide(withEnv({ DO_NOT_TRACK: "1" }))),
  );

  it.live("returns denied when SUPABASE_TELEMETRY_DISABLED=1", () =>
    Effect.gen(function* () {
      const consent = yield* getEffectiveConsent(Option.some(yield* makeConfig("granted")));
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
      const consent = yield* getEffectiveConsent(Option.some(yield* makeConfig("granted")));
      expect(consent).toBe("denied");
    }).pipe(Effect.provide(withEnv({ DO_NOT_TRACK: "1" }))),
  );

  it.live("SUPABASE_TELEMETRY_DISABLED=1 takes precedence over DO_NOT_TRACK=1", () =>
    Effect.gen(function* () {
      const consent = yield* getEffectiveConsent(Option.some(yield* makeConfig("granted")));
      expect(consent).toBe("denied");
    }).pipe(Effect.provide(withEnv({ SUPABASE_TELEMETRY_DISABLED: "1", DO_NOT_TRACK: "1" }))),
  );

  it.live("returns config consent value when set", () =>
    Effect.gen(function* () {
      expect(yield* getEffectiveConsent(Option.some(yield* makeConfig("granted")))).toBe("granted");
      expect(yield* getEffectiveConsent(Option.some(yield* makeConfig("denied")))).toBe("denied");
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
    return withTempDir((dir) =>
      Effect.gen(function* () {
        const expected = yield* makeConfig("denied");
        yield* writeTelemetryFile(dir, yield* encodeJson(expected));
        const config = yield* readTelemetryConfig(dir);
        expect(config).toEqual(Option.some(expected));
      }),
    );
  });

  it.live("decodes a legacy disabled telemetry state as denied consent", () => {
    return withTempDir((dir) =>
      Effect.gen(function* () {
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
      }),
    );
  });

  it.live("decodes a legacy enabled telemetry state as granted consent", () => {
    return withTempDir((dir) =>
      Effect.gen(function* () {
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
      }),
    );
  });

  it.live("returns none for malformed JSON instead of throwing", () => {
    return withTempDir((dir) =>
      Effect.gen(function* () {
        yield* writeTelemetryFile(dir, "");
        const config = yield* readTelemetryConfig(dir);
        expect(config).toEqual(Option.none());
      }),
    );
  });

  it.live("returns none for structurally invalid telemetry config", () => {
    return withTempDir((dir) =>
      Effect.gen(function* () {
        yield* writeTelemetryFile(dir, yield* encodeJson({ consent: "granted" }));
        const config = yield* readTelemetryConfig(dir);
        expect(config).toEqual(Option.none());
      }),
    );
  });
});
