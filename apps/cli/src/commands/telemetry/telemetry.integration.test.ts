import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect, Layer } from "effect";
import { Command } from "effect/unstable/cli";

import {
  mockAnalytics,
  mockOutput,
  mockCliProjectContext,
  mockRuntimeInfo,
  mockTty,
  processEnvLayer,
} from "../../../tests/helpers/mocks.ts";
import { cliSettingsLayer } from "../../shared/config/cli-settings.layer.ts";
import { processControlLayer } from "../../shared/runtime/process-control.layer.ts";
import { EventCommandExecuted } from "../../shared/telemetry/event-catalog.ts";
import { analyticsLayer } from "../../telemetry/analytics.layer.ts";
import { telemetryCommand } from "./telemetry.command.ts";

function makeTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "supabase-telemetry-"));
}

function telemetryPath(dir: string): string {
  return path.join(dir, "telemetry.json");
}

function readTelemetryConfig(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(telemetryPath(dir), "utf8")) as Record<string, unknown>;
}

function setup(dir: string) {
  const out = mockOutput();
  const analytics = mockAnalytics();
  const layer = Layer.mergeAll(
    out.layer,
    analytics.layer,
    BunServices.layer,
    processControlLayer,
    processEnvLayer({ SUPABASE_HOME: dir }),
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
  const configLayer = cliSettingsLayer.pipe(
    Layer.provide(runtimeInfoLayer),
    Layer.provide(cliProjectContextLayer),
  );
  const analytics = analyticsLayer.pipe(
    Layer.provide(configLayer),
    Layer.provide(runtimeInfoLayer),
    Layer.provide(ttyLayer),
    Layer.provide(BunServices.layer),
  );
  const layer = Layer.mergeAll(
    out.layer,
    analytics,
    BunServices.layer,
    processControlLayer,
    envLayer,
  );
  return { out, layer };
}

function testRoot() {
  return Command.make("supabase").pipe(Command.withSubcommands([telemetryCommand]));
}

describe("telemetry integration", () => {
  it.live("status creates legacy telemetry.json and prints Go-style enabled output", () => {
    const dir = makeTempDir();
    const { out, layer } = setup(dir);

    return Effect.gen(function* () {
      yield* Command.runWith(testRoot(), { version: "0.0.0-test" })(["telemetry", "status"]);
      expect(out.stdoutText).toBe("Telemetry is enabled.\n");
      expect(existsSync(telemetryPath(dir))).toBe(true);
      const config = readTelemetryConfig(dir);
      expect(config.enabled).toBe(true);
      expect(config.schema_version).toBe(1);
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true }))),
    ) as Effect.Effect<void>;
  });

  it.live("enable preserves prior identity fields and prints Go-style enabled output", () => {
    const dir = makeTempDir();
    const { out, layer } = setup(dir);

    writeFileSync(
      telemetryPath(dir),
      JSON.stringify({
        enabled: false,
        device_id: "device-123",
        session_id: "session-123",
        session_last_active: "2026-01-01T00:00:00.000Z",
        distinct_id: "user-123",
        schema_version: 1,
      }),
    );

    return Effect.gen(function* () {
      yield* Command.runWith(testRoot(), { version: "0.0.0-test" })(["telemetry", "enable"]);
      expect(out.stdoutText).toBe("Telemetry is enabled.\n");
      const config = readTelemetryConfig(dir);
      expect(config.enabled).toBe(true);
      expect(config.device_id).toBe("device-123");
      expect(config.distinct_id).toBe("user-123");
      expect(config.schema_version).toBe(1);
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true }))),
    ) as Effect.Effect<void>;
  });

  it.live("disable preserves prior identity fields and prints Go-style disabled output", () => {
    const dir = makeTempDir();
    const { out, layer } = setup(dir);

    writeFileSync(
      telemetryPath(dir),
      JSON.stringify({
        enabled: true,
        device_id: "device-123",
        session_id: "session-123",
        session_last_active: "2026-01-01T00:00:00.000Z",
        distinct_id: "user-123",
        schema_version: 1,
      }),
    );

    return Effect.gen(function* () {
      yield* Command.runWith(testRoot(), { version: "0.0.0-test" })(["telemetry", "disable"]);
      expect(out.stdoutText).toBe("Telemetry is disabled.\n");
      const config = readTelemetryConfig(dir);
      expect(config.enabled).toBe(false);
      expect(config.device_id).toBe("device-123");
      expect(config.distinct_id).toBe("user-123");
      expect(config.schema_version).toBe(1);
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true }))),
    ) as Effect.Effect<void>;
  });

  it.live("status recovers a malformed legacy telemetry.json instead of failing", () => {
    const dir = makeTempDir();
    const { out, layer } = setup(dir);

    writeFileSync(telemetryPath(dir), "{not valid json}");

    return Effect.gen(function* () {
      yield* Command.runWith(testRoot(), { version: "0.0.0-test" })(["telemetry", "status"]);
      expect(out.stdoutText).toBe("Telemetry is enabled.\n");
      const config = readTelemetryConfig(dir);
      expect(config.enabled).toBe(true);
      expect(config.schema_version).toBe(1);
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true }))),
    ) as Effect.Effect<void>;
  });

  // mockAnalytics() unconditionally records every capture, bypassing consent, so these
  // assert only that disable/enable stopped force-suppressing analytics via
  // `analytics: false`. See runtime.layer.unit.test.ts for the snapshot-timing proof.
  it.live("disable no longer force-suppresses cli_command_executed", () => {
    const dir = makeTempDir();
    const { analytics, layer } = setup(dir);

    return Effect.gen(function* () {
      yield* Command.runWith(testRoot(), { version: "0.0.0-test" })(["telemetry", "disable"]);
      expect(analytics.captured.map((event) => event.event)).toContain(EventCommandExecuted);
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true }))),
    ) as Effect.Effect<void>;
  });

  it.live("enable no longer force-suppresses cli_command_executed", () => {
    const dir = makeTempDir();
    const { analytics, layer } = setup(dir);

    return Effect.gen(function* () {
      yield* Command.runWith(testRoot(), { version: "0.0.0-test" })(["telemetry", "enable"]);
      expect(analytics.captured.map((event) => event.event)).toContain(EventCommandExecuted);
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true }))),
    ) as Effect.Effect<void>;
  });

  it.live("disable runs cleanly through the real consent-gated analytics layer", () => {
    const dir = makeTempDir();
    writeFileSync(
      telemetryPath(dir),
      JSON.stringify({
        enabled: true,
        device_id: "device-123",
        session_id: "session-123",
        session_last_active: "2026-01-01T00:00:00.000Z",
        schema_version: 1,
      }),
    );
    const { out, layer } = setupWithRealAnalytics(dir);

    return Effect.gen(function* () {
      yield* Command.runWith(testRoot(), { version: "0.0.0-test" })(["telemetry", "disable"]);
      expect(out.stdoutText).toBe("Telemetry is disabled.\n");
      expect(readTelemetryConfig(dir).enabled).toBe(false);
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true }))),
    ) as Effect.Effect<void>;
  });

  it.live("enable runs cleanly through the real consent-gated analytics layer", () => {
    const dir = makeTempDir();
    writeFileSync(
      telemetryPath(dir),
      JSON.stringify({
        enabled: false,
        device_id: "device-123",
        session_id: "session-123",
        session_last_active: "2026-01-01T00:00:00.000Z",
        schema_version: 1,
      }),
    );
    const { out, layer } = setupWithRealAnalytics(dir);

    return Effect.gen(function* () {
      yield* Command.runWith(testRoot(), { version: "0.0.0-test" })(["telemetry", "enable"]);
      expect(out.stdoutText).toBe("Telemetry is enabled.\n");
      expect(readTelemetryConfig(dir).enabled).toBe(true);
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true }))),
    ) as Effect.Effect<void>;
  });

  it.live(
    "status treats malformed typed fields as a corrupted file and regenerates identity",
    () => {
      const dir = makeTempDir();
      const { out, layer } = setup(dir);

      writeFileSync(
        telemetryPath(dir),
        JSON.stringify({
          enabled: false,
          device_id: "device-123",
          session_id: "session-123",
          session_last_active: "not-a-time",
          distinct_id: "user-123",
          schema_version: 1,
        }),
      );

      return Effect.gen(function* () {
        yield* Command.runWith(testRoot(), { version: "0.0.0-test" })(["telemetry", "status"]);
        expect(out.stdoutText).toBe("Telemetry is enabled.\n");
        const config = readTelemetryConfig(dir);
        expect(config.enabled).toBe(true);
        expect(config.device_id).not.toBe("device-123");
        expect(config.session_id).not.toBe("session-123");
        expect(config.distinct_id).toBeUndefined();
        expect(config.schema_version).toBe(1);
      }).pipe(
        Effect.provide(layer),
        Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true }))),
      ) as Effect.Effect<void>;
    },
  );
});
