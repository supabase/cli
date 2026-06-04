import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect, Layer } from "effect";
import { Command } from "effect/unstable/cli";

import { mockAnalytics, mockOutput, processEnvLayer } from "../../../../tests/helpers/mocks.ts";
import { legacyTelemetryCommand } from "./telemetry.command.ts";

function makeTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "supabase-legacy-telemetry-"));
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
    processEnvLayer({ SUPABASE_HOME: dir }),
  );
  return { out, layer };
}

function legacyTestRoot() {
  return Command.make("supabase").pipe(Command.withSubcommands([legacyTelemetryCommand]));
}

describe("legacy telemetry integration", () => {
  it.live("status creates legacy telemetry.json and prints Go-style enabled output", () => {
    const dir = makeTempDir();
    const { out, layer } = setup(dir);

    return Effect.gen(function* () {
      yield* Command.runWith(legacyTestRoot(), { version: "0.0.0-test" })(["telemetry", "status"]);
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
      yield* Command.runWith(legacyTestRoot(), { version: "0.0.0-test" })(["telemetry", "enable"]);
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
      yield* Command.runWith(legacyTestRoot(), { version: "0.0.0-test" })(["telemetry", "disable"]);
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
      yield* Command.runWith(legacyTestRoot(), { version: "0.0.0-test" })(["telemetry", "status"]);
      expect(out.stdoutText).toBe("Telemetry is enabled.\n");
      const config = readTelemetryConfig(dir);
      expect(config.enabled).toBe(true);
      expect(config.schema_version).toBe(1);
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
        yield* Command.runWith(legacyTestRoot(), { version: "0.0.0-test" })([
          "telemetry",
          "status",
        ]);
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
