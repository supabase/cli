import { describe, expect, it } from "@effect/vitest";
import { BunCrypto, BunServices } from "@effect/platform-bun";
import { ConfigProvider, Effect, FileSystem, Layer, Path, Schema } from "effect";
import { Command } from "effect/cli";
import { FetchHttpClient } from "effect/http";

import {
  mockAnalytics,
  mockOutput,
  mockCliProjectContext,
  mockRuntimeInfo,
  mockTty,
  processEnvLayer,
} from "../../../tests/helpers/mocks.ts";
import { useTempWorkdir } from "../../../tests/helpers/command-mocks.ts";
import { cliSettingsLayer } from "../../shared/config/cli-settings.layer.ts";
import { processControlLayer } from "../../shared/runtime/process-control.layer.ts";
import { EventCommandExecuted } from "../../shared/telemetry/event-catalog.ts";
import { telemetryRuntimeLayer } from "../../shared/telemetry/runtime.layer.ts";
import { analyticsLayer } from "../../telemetry/analytics.layer.ts";
import { telemetryCommand } from "./telemetry.command.ts";

const tempRoot = useTempWorkdir("supabase-telemetry-");

const TELEMETRY_FILE = "telemetry.json";

const writeTelemetryConfig = (dir: string, contents: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.writeFileString(path.join(dir, TELEMETRY_FILE), contents);
  }).pipe(Effect.provide([BunServices.layer, BunCrypto.layer]));

const telemetryConfigExists = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* fs.exists(path.join(dir, TELEMETRY_FILE));
  }).pipe(Effect.provide([BunServices.layer, BunCrypto.layer]));

const readTelemetryConfig = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const text = yield* fs.readFileString(path.join(dir, TELEMETRY_FILE));
    return yield* Schema.decodeEffect(
      Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
    )(text);
  }).pipe(Effect.provide([BunServices.layer, BunCrypto.layer]));

// `dir` is the home the CLI settings resolve. `ambientHome` differs from it when a project
// `.env` sets `SUPABASE_HOME`.
function setup(dir: string, optOutEnv: Record<string, string> = {}, ambientHome = dir) {
  const out = mockOutput();
  const analytics = mockAnalytics();
  const runtimeInfoLayer = mockRuntimeInfo({ homeDir: dir });
  const envLayer = processEnvLayer({
    SUPABASE_HOME: ambientHome,
    SUPABASE_TELEMETRY_DISABLED: undefined,
    DO_NOT_TRACK: undefined,
    ...optOutEnv,
  });
  const settingsEnvLayer = ConfigProvider.layer(
    ConfigProvider.fromEnvRecord({ SUPABASE_HOME: dir, ...optOutEnv }),
  );
  const configLayer = cliSettingsLayer.pipe(
    Layer.provide(runtimeInfoLayer),
    Layer.provide(mockCliProjectContext()),
    Layer.provide(settingsEnvLayer),
    Layer.provide(envLayer),
    Layer.provide([BunServices.layer, BunCrypto.layer]),
  );
  const runtimeLayer = telemetryRuntimeLayer.pipe(
    Layer.provide(configLayer),
    Layer.provide(runtimeInfoLayer),
    Layer.provide(mockTty()),
    Layer.provide([BunServices.layer, BunCrypto.layer]),
  );
  const layer = Layer.mergeAll(
    out.layer,
    analytics.layer,
    runtimeLayer,
    BunServices.layer,
    BunCrypto.layer,
    processControlLayer,
    envLayer,
  );
  return { out, analytics, layer };
}

// Uses the real analyticsLayer (no PostHog key set, so it always resolves to its
// no-op branch) to prove the command runs the consent-gated layer end-to-end without
// crashing. The snapshot-timing mechanism itself is proven in runtime.layer.unit.test.ts.
function setupWithRealAnalytics(dir: string) {
  const out = mockOutput();
  const runtimeInfoLayer = mockRuntimeInfo({ homeDir: dir });
  const ttyLayer = mockTty();
  const envLayer = processEnvLayer({ SUPABASE_HOME: dir });
  const cliProjectContextLayer = mockCliProjectContext();
  // The env sandbox must be built before cliSettings reads process.env at layer build
  // time; Layer.mergeAll builds concurrently, so sequence it as a dependency instead.
  const configLayer = cliSettingsLayer.pipe(
    Layer.provide(runtimeInfoLayer),
    Layer.provide(cliProjectContextLayer),
    Layer.provide(envLayer),
    Layer.provide([BunServices.layer, BunCrypto.layer]),
  );
  const analytics = analyticsLayer.pipe(
    Layer.provide(configLayer),
    Layer.provide(runtimeInfoLayer),
    Layer.provide(ttyLayer),
    Layer.provide([BunServices.layer, BunCrypto.layer]),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(envLayer),
  );
  const runtimeLayer = telemetryRuntimeLayer.pipe(
    Layer.provide(configLayer),
    Layer.provide(runtimeInfoLayer),
    Layer.provide(ttyLayer),
    Layer.provide([BunServices.layer, BunCrypto.layer]),
  );
  const layer = Layer.mergeAll(
    out.layer,
    analytics,
    runtimeLayer,
    BunServices.layer,
    BunCrypto.layer,
    processControlLayer,
    envLayer,
  );
  return { out, layer };
}

function testRoot() {
  return Command.make("supabase").pipe(Command.withSubcommands([telemetryCommand]));
}

function runTelemetry(args: Array<string>) {
  return Command.runWith(testRoot(), { version: "0.0.0-test" })(args);
}

describe("telemetry integration", () => {
  it.live("status prints the enabled output on a first run", () => {
    const dir = tempRoot.current;
    const { out, layer } = setup(dir);

    return Effect.gen(function* () {
      yield* runTelemetry(["telemetry", "status"]).pipe(Effect.provide(layer));
      expect(out.stdoutText).toBe("Telemetry is enabled.\n");
    });
  });

  for (const variable of ["SUPABASE_TELEMETRY_DISABLED", "DO_NOT_TRACK"]) {
    it.live(`status names ${variable}=1 as the opt-out and leaves no state file`, () => {
      const dir = tempRoot.current;
      const { out, layer } = setup(dir, { [variable]: "1" });

      return Effect.gen(function* () {
        yield* runTelemetry(["telemetry", "status"]).pipe(Effect.provide(layer));
        expect(out.stdoutText).toBe(`Telemetry is disabled (${variable}=1).\n`);
        expect(yield* telemetryConfigExists(dir)).toBe(false);
      });
    });
  }

  it.live("enable preserves prior identity fields and prints the enabled output", () => {
    const dir = tempRoot.current;
    const { out, layer } = setup(dir);
    const seed = JSON.stringify({
      enabled: false,
      device_id: "device-123",
      session_id: "session-123",
      session_last_active: "2026-01-01T00:00:00.000Z",
      distinct_id: "user-123",
      schema_version: 1,
    });

    return Effect.gen(function* () {
      yield* writeTelemetryConfig(dir, seed);
      yield* runTelemetry(["telemetry", "enable"]).pipe(Effect.provide(layer));
      expect(out.stdoutText).toBe("Telemetry is enabled.\n");
      const config = yield* readTelemetryConfig(dir);
      expect(config.enabled).toBe(true);
      expect(config.device_id).toBe("device-123");
      expect(config.distinct_id).toBe("user-123");
      expect(config.schema_version).toBe(1);
    });
  });

  it.live("disable preserves prior identity fields and prints the disabled output", () => {
    const dir = tempRoot.current;
    const { out, layer } = setup(dir);
    const seed = JSON.stringify({
      enabled: true,
      device_id: "device-123",
      session_id: "session-123",
      session_last_active: "2026-01-01T00:00:00.000Z",
      distinct_id: "user-123",
      schema_version: 1,
    });

    return Effect.gen(function* () {
      yield* writeTelemetryConfig(dir, seed);
      yield* runTelemetry(["telemetry", "disable"]).pipe(Effect.provide(layer));
      expect(out.stdoutText).toBe("Telemetry is disabled.\n");
      const config = yield* readTelemetryConfig(dir);
      expect(config.enabled).toBe(false);
      expect(config.device_id).toBe("device-123");
      expect(config.distinct_id).toBe("user-123");
      expect(config.schema_version).toBe(1);
    });
  });

  it.live("status reports a malformed telemetry.json as disabled instead of failing", () => {
    const dir = tempRoot.current;
    const { out, layer } = setup(dir);

    return Effect.gen(function* () {
      yield* writeTelemetryConfig(dir, "{not valid json}");
      yield* runTelemetry(["telemetry", "status"]).pipe(Effect.provide(layer));
      expect(out.stdoutText).toBe("Telemetry is disabled.\n");
    });
  });

  // mockAnalytics() records every capture, bypassing consent, so these assert only whether the
  // command asks for its own event.
  it.live("disable sends no cli_command_executed", () => {
    const dir = tempRoot.current;
    const { analytics, layer } = setup(dir);

    return Effect.gen(function* () {
      yield* runTelemetry(["telemetry", "disable"]).pipe(Effect.provide(layer));
      expect(analytics.captured.map((event) => event.event)).not.toContain(EventCommandExecuted);
    });
  });

  it.live("enable no longer force-suppresses cli_command_executed", () => {
    const dir = tempRoot.current;
    const { analytics, layer } = setup(dir);

    return Effect.gen(function* () {
      yield* runTelemetry(["telemetry", "enable"]).pipe(Effect.provide(layer));
      expect(analytics.captured.map((event) => event.event)).toContain(EventCommandExecuted);
    });
  });

  it.live("disable runs cleanly through the real consent-gated analytics layer", () => {
    const dir = tempRoot.current;
    const { out, layer } = setupWithRealAnalytics(dir);
    const seed = JSON.stringify({
      enabled: true,
      device_id: "device-123",
      session_id: "session-123",
      session_last_active: "2026-01-01T00:00:00.000Z",
      schema_version: 1,
    });

    return Effect.gen(function* () {
      yield* writeTelemetryConfig(dir, seed);
      yield* runTelemetry(["telemetry", "disable"]).pipe(Effect.provide(layer));
      expect(out.stdoutText).toBe("Telemetry is disabled.\n");
      expect((yield* readTelemetryConfig(dir)).enabled).toBe(false);
    });
  });

  it.live("enable runs cleanly through the real consent-gated analytics layer", () => {
    const dir = tempRoot.current;
    const { out, layer } = setupWithRealAnalytics(dir);
    const seed = JSON.stringify({
      enabled: false,
      device_id: "device-123",
      session_id: "session-123",
      session_last_active: "2026-01-01T00:00:00.000Z",
      schema_version: 1,
    });

    return Effect.gen(function* () {
      yield* writeTelemetryConfig(dir, seed);
      yield* runTelemetry(["telemetry", "enable"]).pipe(Effect.provide(layer));
      expect(out.stdoutText).toBe("Telemetry is enabled.\n");
      expect((yield* readTelemetryConfig(dir)).enabled).toBe(true);
    });
  });

  it.live("disable writes the opt-out to the home the CLI reads consent from", () => {
    const dir = tempRoot.current;

    return Effect.gen(function* () {
      const path = yield* Path.Path;
      const ambientHome = path.join(dir, "ambient-home");
      const disable = setup(dir, {}, ambientHome);
      yield* runTelemetry(["telemetry", "disable"]).pipe(Effect.provide(disable.layer));

      const status = setup(dir, {}, ambientHome);
      yield* runTelemetry(["telemetry", "status"]).pipe(Effect.provide(status.layer));
      expect(status.out.stdoutText).toBe("Telemetry is disabled.\n");
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.live("an opt-out in a file with a malformed field stays an opt-out", () => {
    const dir = tempRoot.current;
    const seed = JSON.stringify({
      enabled: false,
      device_id: "device-123",
      session_id: "session-123",
      session_last_active: "not-a-time",
      distinct_id: "user-123",
      schema_version: 1,
    });

    return Effect.gen(function* () {
      yield* writeTelemetryConfig(dir, seed);
      const status = setup(dir);
      yield* runTelemetry(["telemetry", "status"]).pipe(Effect.provide(status.layer));
      expect(status.out.stdoutText).toBe("Telemetry is disabled.\n");

      const disable = setup(dir);
      yield* runTelemetry(["telemetry", "disable"]).pipe(Effect.provide(disable.layer));
      const config = yield* readTelemetryConfig(dir);
      expect(config.enabled).toBe(false);
      expect(config.device_id).not.toBe("device-123");
      expect(config.distinct_id).toBeUndefined();
    });
  });
});
