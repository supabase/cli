import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Data, Effect, FileSystem, Layer, Path, Schema } from "effect";
import { cliConfigLayer } from "../../next/config/cli-config.layer.ts";
import { TelemetryRuntime } from "./runtime.service.ts";
import { telemetryRuntimeLayer } from "./runtime.layer.ts";
import {
  mockProjectContext,
  mockRuntimeInfo,
  mockTty,
  processEnvLayer,
} from "../../../tests/helpers/mocks.ts";

const fsLayer = BunServices.layer;

class RuntimeTestSchemaError extends Data.TaggedError("RuntimeTestSchemaError")<{
  readonly cause: unknown;
}> {}

const makeTempDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectory({ prefix: "supabase-runtime-test-" });
});

const pathJoin = (...parts: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return path.join(...parts);
  });

const pathExists = (pathname: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.exists(pathname);
  });

const writeText = (pathname: string, content: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.dirname(pathname), { recursive: true });
    yield* fs.writeFileString(pathname, content);
  });

const removePath = (pathname: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(pathname, { recursive: true, force: true });
  }).pipe(Effect.ignore);

const encodeJson = (value: unknown) =>
  Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(value).pipe(
    Effect.mapError((cause) => new RuntimeTestSchemaError({ cause })),
  );

const withHomeDir = <A, E, R>(use: (homeDir: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const homeDir = yield* makeTempDir;
    return yield* use(homeDir).pipe(Effect.ensuring(removePath(homeDir)));
  }).pipe(Effect.provide(fsLayer));

function buildLayer(opts: {
  homeDir: string;
  env?: Record<string, string>;
  stdoutIsTty?: boolean;
}) {
  const runtimeInfoLayer = mockRuntimeInfo({ homeDir: opts.homeDir });
  const projectContextLayer = mockProjectContext();
  const envLayer = processEnvLayer({
    ...opts.env,
  });
  const ttyLayer = mockTty({ stdoutIsTty: opts.stdoutIsTty ?? false });
  const configLayer = cliConfigLayer.pipe(
    Layer.provide(runtimeInfoLayer),
    Layer.provide(projectContextLayer),
    Layer.provide(envLayer),
  );
  const telemetryLayer = telemetryRuntimeLayer.pipe(
    Layer.provide(configLayer),
    Layer.provide(runtimeInfoLayer),
    Layer.provide(ttyLayer),
    Layer.provide(BunServices.layer),
  );

  return telemetryLayer;
}

describe("telemetryRuntimeLayer", () => {
  it.live("does not create telemetry.json when telemetry is disabled by env on first run", () => {
    return withHomeDir((homeDir) =>
      Effect.gen(function* () {
        const configPath = yield* pathJoin(homeDir, ".supabase", "telemetry.json");
        const runtime = yield* TelemetryRuntime;
        expect(runtime.consent).toBe("denied");
        expect(runtime.isFirstRun).toBe(false);
        expect(yield* pathExists(configPath)).toBe(false);
      }).pipe(Effect.provide(buildLayer({ homeDir, env: { SUPABASE_TELEMETRY_DISABLED: "1" } }))),
    );
  });

  it.live("marks the actual first granted invocation as first run", () => {
    return withHomeDir((homeDir) =>
      Effect.gen(function* () {
        const configPath = yield* pathJoin(homeDir, ".supabase", "telemetry.json");
        const runtime = yield* TelemetryRuntime;
        expect(runtime.consent).toBe("granted");
        expect(runtime.isFirstRun).toBe(true);
        expect(yield* pathExists(configPath)).toBe(true);
      }).pipe(Effect.provide(buildLayer({ homeDir }))),
    );
  });

  it.live("treats a malformed telemetry.json as a fresh first run instead of crashing", () => {
    return withHomeDir((homeDir) =>
      Effect.gen(function* () {
        const configPath = yield* pathJoin(homeDir, ".supabase", "telemetry.json");
        yield* writeText(configPath, "");
        const runtime = yield* TelemetryRuntime;
        expect(runtime.consent).toBe("granted");
        expect(runtime.isFirstRun).toBe(true);
        expect(yield* pathExists(configPath)).toBe(true);
      }).pipe(Effect.provide(buildLayer({ homeDir }))),
    );
  });

  it.live("silently ignores structurally invalid telemetry.json instead of crashing", () => {
    return withHomeDir((homeDir) =>
      Effect.gen(function* () {
        const configPath = yield* pathJoin(homeDir, ".supabase", "telemetry.json");
        yield* writeText(configPath, yield* encodeJson({ consent: "granted" }));
        const runtime = yield* TelemetryRuntime;
        expect(runtime.consent).toBe("granted");
        expect(runtime.isFirstRun).toBe(true);
        expect(yield* pathExists(configPath)).toBe(true);
      }).pipe(Effect.provide(buildLayer({ homeDir }))),
    );
  });

  it.live("honors a legacy disabled telemetry state", () => {
    return withHomeDir((homeDir) =>
      Effect.gen(function* () {
        const configPath = yield* pathJoin(homeDir, ".supabase", "telemetry.json");
        yield* writeText(
          configPath,
          yield* encodeJson({
            enabled: false,
            device_id: "legacy-device",
            session_id: "legacy-session",
            session_last_active: "2026-04-01T12:00:00Z",
            schema_version: 1,
          }),
        );
        const runtime = yield* Effect.gen(function* () {
          const runtime = yield* TelemetryRuntime;
          expect(runtime.consent).toBe("denied");
          expect(runtime.deviceId).toBe("legacy-device");
          expect(runtime.sessionId).toBe("legacy-session");
          expect(runtime.isFirstRun).toBe(false);
          return runtime;
        }).pipe(Effect.provide(buildLayer({ homeDir, stdoutIsTty: true })));
        expect(runtime.consent).toBe("denied");
        expect(yield* pathExists(configPath)).toBe(true);
      }),
    );
  });

  // CLI-1868 (telemetry enable/disable firing cli_command_executed on pre-toggle
  // consent) depends on this exact property: `consent` is read from disk once
  // at layer-construction time and does not reflect a later on-disk write —
  // mirroring Go's PersistentPreRunE snapshot, which a command's own RunE
  // (e.g. `telemetry disable`'s SetEnabled) cannot retroactively change.
  it.live("captures consent once; a later on-disk write does not change it", () => {
    return withHomeDir((homeDir) =>
      Effect.gen(function* () {
        const configPath = yield* pathJoin(homeDir, ".supabase", "telemetry.json");
        yield* writeText(
          configPath,
          yield* encodeJson({
            enabled: true,
            device_id: "device-123",
            session_id: "session-123",
            session_last_active: "2026-04-01T12:00:00Z",
            schema_version: 1,
          }),
        );
        const runtime = yield* TelemetryRuntime.pipe(Effect.provide(buildLayer({ homeDir })));
        expect(runtime.consent).toBe("granted");

        // Simulates `disable`'s handler rewriting the file mid-command, after
        // this layer already resolved `consent` — the already-built runtime
        // must keep reporting the pre-toggle value.
        yield* writeText(
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
      }),
    );
  });
});
