import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import {
  Config,
  ConfigProvider,
  Effect,
  FileSystem,
  Layer,
  Path,
  PlatformError,
  Schema,
} from "effect";
import { cliSettingsLayer } from "../config/cli-settings.layer.ts";
import { TelemetryRuntime } from "./runtime.service.ts";
import { telemetryRuntimeLayer } from "./runtime.layer.ts";
import {
  mockCliProjectContext,
  mockRuntimeInfo,
  mockTty,
  processEnvLayer,
} from "../../../tests/helpers/mocks.ts";
import { useTempWorkdir } from "../../../tests/helpers/command-mocks.ts";

const tempRoot = useTempWorkdir("supabase-runtime-test-");

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const telemetryConfigPath = (homeDir: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return path.join(homeDir, "telemetry.json");
  });

function buildLayer(opts: {
  homeDir: string;
  env?: Record<string, string>;
  stdoutIsTty?: boolean;
}): Layer.Layer<TelemetryRuntime, Config.ConfigError | PlatformError.PlatformError> {
  const runtimeInfoLayer = mockRuntimeInfo({ homeDir: opts.homeDir });
  const cliProjectContextLayer = mockCliProjectContext();
  const envLayer = processEnvLayer({
    SUPABASE_HOME: opts.homeDir,
    ...opts.env,
  });
  const providerLayer = ConfigProvider.layer(
    ConfigProvider.fromEnvRecord(
      { SUPABASE_HOME: opts.homeDir, ...opts.env },
      { preserveEmptyStrings: true },
    ),
  );
  const ttyLayer = mockTty({ stdoutIsTty: opts.stdoutIsTty ?? false });
  const configLayer = cliSettingsLayer.pipe(
    Layer.provide(runtimeInfoLayer),
    Layer.provide(cliProjectContextLayer),
    Layer.provide(providerLayer),
    Layer.provide(BunServices.layer),
  );
  const telemetryLayer = telemetryRuntimeLayer.pipe(
    Layer.provide(configLayer),
    Layer.provide(runtimeInfoLayer),
    Layer.provide(ttyLayer),
    Layer.provide(BunServices.layer),
    Layer.provide(providerLayer),
  );

  return Layer.mergeAll(envLayer, telemetryLayer);
}

describe("telemetryRuntimeLayer", () => {
  it.effect("does not create telemetry.json when telemetry is disabled by env on first run", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const homeDir = tempRoot.current;
      const configPath = yield* telemetryConfigPath(homeDir);

      yield* Effect.gen(function* () {
        const runtime = yield* TelemetryRuntime;
        expect(runtime.consent).toBe("denied");
        expect(runtime.isFirstRun).toBe(false);
        expect(yield* fs.exists(configPath)).toBe(false);
      }).pipe(
        Effect.provide(
          buildLayer({
            homeDir,
            env: { SUPABASE_TELEMETRY_DISABLED: "1" },
          }),
        ),
      );
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("marks the actual first granted invocation as first run", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const homeDir = tempRoot.current;
      const configPath = yield* telemetryConfigPath(homeDir);

      yield* Effect.gen(function* () {
        const runtime = yield* TelemetryRuntime;
        expect(runtime.consent).toBe("granted");
        expect(runtime.isFirstRun).toBe(true);
        expect(yield* fs.exists(configPath)).toBe(true);
      }).pipe(Effect.provide(buildLayer({ homeDir })));
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("treats a malformed telemetry.json as a fresh first run instead of crashing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const homeDir = tempRoot.current;
      const configPath = yield* telemetryConfigPath(homeDir);
      yield* fs.writeFileString(configPath, "");

      yield* Effect.gen(function* () {
        const runtime = yield* TelemetryRuntime;
        expect(runtime.consent).toBe("granted");
        expect(runtime.isFirstRun).toBe(true);
        expect(yield* fs.exists(configPath)).toBe(true);
      }).pipe(Effect.provide(buildLayer({ homeDir })));
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("silently ignores structurally invalid telemetry.json instead of crashing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const homeDir = tempRoot.current;
      const configPath = yield* telemetryConfigPath(homeDir);
      yield* fs.writeFileString(configPath, yield* encodeJson({ consent: "granted" }));

      yield* Effect.gen(function* () {
        const runtime = yield* TelemetryRuntime;
        expect(runtime.consent).toBe("granted");
        expect(runtime.isFirstRun).toBe(true);
        expect(yield* fs.exists(configPath)).toBe(true);
      }).pipe(Effect.provide(buildLayer({ homeDir })));
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("honors a legacy disabled telemetry state", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const homeDir = tempRoot.current;
      const configPath = yield* telemetryConfigPath(homeDir);
      yield* fs.writeFileString(
        configPath,
        yield* encodeJson({
          enabled: false,
          device_id: "legacy-device",
          session_id: "legacy-session",
          session_last_active: "2026-04-01T12:00:00Z",
          schema_version: 1,
        }),
      );

      yield* Effect.gen(function* () {
        const runtime = yield* TelemetryRuntime;
        expect(runtime.consent).toBe("denied");
        expect(runtime.deviceId).toBe("legacy-device");
        expect(runtime.sessionId).toBe("legacy-session");
        expect(runtime.isFirstRun).toBe(false);
        expect(yield* fs.exists(configPath)).toBe(true);
      }).pipe(Effect.provide(buildLayer({ homeDir, stdoutIsTty: true })));
    }).pipe(Effect.provide(BunServices.layer)),
  );

  // `consent` is read from disk once at layer-construction time and does not reflect a later
  // on-disk write, so a command that rewrites telemetry.json mid-run doesn't retroactively
  // change what that invocation already captured.
  it.effect("captures consent once; a later on-disk write does not change it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const homeDir = tempRoot.current;
      const configPath = yield* telemetryConfigPath(homeDir);
      yield* fs.writeFileString(
        configPath,
        yield* encodeJson({
          enabled: true,
          device_id: "device-123",
          session_id: "session-123",
          session_last_active: "2026-04-01T12:00:00Z",
          schema_version: 1,
        }),
      );

      yield* Effect.gen(function* () {
        const runtime = yield* TelemetryRuntime;
        expect(runtime.consent).toBe("granted");

        // Simulates `disable` rewriting telemetry.json mid-command, after this layer already
        // resolved `consent`.
        yield* fs.writeFileString(
          configPath,
          yield* encodeJson({
            enabled: false,
            device_id: "device-123",
            session_id: "session-123",
            session_last_active: "2026-04-01T12:00:00Z",
            schema_version: 1,
          }),
        );

        expect(runtime.consent).toBe("granted");
      }).pipe(Effect.provide(buildLayer({ homeDir })));
    }).pipe(Effect.provide(BunServices.layer)),
  );
});
