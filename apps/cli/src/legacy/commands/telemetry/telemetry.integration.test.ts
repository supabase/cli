import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Formatter, Layer, Path, Schema } from "effect";
import { Command } from "effect/unstable/cli";

import {
  mockAnalytics,
  mockOutput,
  mockProjectContext,
  mockRuntimeInfo,
  mockTty,
  processEnvLayer,
} from "../../../../tests/helpers/mocks.ts";
import { useLegacyTempWorkdir } from "../../../../tests/helpers/legacy-mocks.ts";
import { cliConfigLayer } from "../../../next/config/cli-config.layer.ts";
import { processControlLayer } from "../../../shared/runtime/process-control.layer.ts";
import { EventCommandExecuted } from "../../../shared/telemetry/event-catalog.ts";
import { legacyAnalyticsLayer } from "../../telemetry/legacy-analytics.layer.ts";
import { legacyTelemetryCommand } from "./telemetry.command.ts";

const tempRoot = useLegacyTempWorkdir("supabase-legacy-telemetry-");

function writeTelemetryFile(dir: string, contents: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.writeFileString(path.join(dir, "telemetry.json"), contents);
  }).pipe(Effect.provide(BunServices.layer));
}

function writeTelemetryConfig(dir: string, value: unknown) {
  return writeTelemetryFile(dir, Formatter.formatJson(value));
}

function readTelemetryConfig(dir: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const contents = yield* fs.readFileString(path.join(dir, "telemetry.json"));
    return yield* Schema.decodeEffect(
      Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
    )(contents);
  }).pipe(Effect.provide(BunServices.layer));
}

function telemetryFileExists(dir: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* fs.exists(path.join(dir, "telemetry.json"));
  }).pipe(Effect.provide(BunServices.layer));
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

// Wires the REAL `legacyAnalyticsLayer` (consent-gated, backed by
// `telemetryRuntimeLayer` reading `dir`'s telemetry.json) instead of
// `mockAnalytics()` — the un-mocked boundary `Analytics.capture` calls
// actually pass through. No PostHog key is set in the test env, so
// `legacyAnalyticsLayer` resolves to its no-op branch regardless of consent
// (real-network PostHog delivery has no test double anywhere in this repo);
// this proves the command runs the real consent-gated layer end-to-end
// without crashing, not the exact PostHog call count. The snapshot-timing
// mechanism itself (pre-toggle consent surviving the handler's own disk
// write) is proven directly in `runtime.layer.unit.test.ts`.
function setupWithRealAnalytics(dir: string) {
  const out = mockOutput();
  const runtimeInfoLayer = mockRuntimeInfo({ homeDir: dir });
  const ttyLayer = mockTty();
  const envLayer = processEnvLayer({ SUPABASE_HOME: dir });
  const projectContextLayer = mockProjectContext();
  const configLayer = cliConfigLayer.pipe(
    Layer.provide(runtimeInfoLayer),
    Layer.provide(projectContextLayer),
  );
  const analyticsLayer = legacyAnalyticsLayer.pipe(
    Layer.provide(configLayer),
    Layer.provide(runtimeInfoLayer),
    Layer.provide(ttyLayer),
    Layer.provide(BunServices.layer),
  );
  const layer = analyticsLayer.pipe(
    Layer.provideMerge(Layer.mergeAll(out.layer, processControlLayer, envLayer, BunServices.layer)),
  );
  return { out, layer };
}

function legacyTestRoot() {
  return Command.make("supabase").pipe(Command.withSubcommands([legacyTelemetryCommand]));
}

describe("legacy telemetry integration", () => {
  it.live("status creates legacy telemetry.json and prints Go-style enabled output", () => {
    const dir = tempRoot.current;
    const { out, layer } = setup(dir);

    return Effect.gen(function* () {
      yield* Command.runWith(legacyTestRoot(), { version: "0.0.0-test" })(["telemetry", "status"]);
      expect(out.stdoutText).toBe("Telemetry is enabled.\n");
      expect(yield* telemetryFileExists(dir)).toBe(true);
      const config = yield* readTelemetryConfig(dir);
      expect(config.enabled).toBe(true);
      expect(config.schema_version).toBe(1);
    }).pipe(Effect.provide(layer));
  });

  it.live("enable preserves prior identity fields and prints Go-style enabled output", () => {
    const dir = tempRoot.current;
    const { out, layer } = setup(dir);

    const initial = {
      enabled: false,
      device_id: "device-123",
      session_id: "session-123",
      session_last_active: "2026-01-01T00:00:00.000Z",
      distinct_id: "user-123",
      schema_version: 1,
    };

    return Effect.gen(function* () {
      yield* writeTelemetryConfig(dir, initial);
      yield* Command.runWith(legacyTestRoot(), { version: "0.0.0-test" })(["telemetry", "enable"]);
      expect(out.stdoutText).toBe("Telemetry is enabled.\n");
      const config = yield* readTelemetryConfig(dir);
      expect(config.enabled).toBe(true);
      expect(config.device_id).toBe("device-123");
      expect(config.distinct_id).toBe("user-123");
      expect(config.schema_version).toBe(1);
    }).pipe(Effect.provide(layer));
  });

  it.live("disable preserves prior identity fields and prints Go-style disabled output", () => {
    const dir = tempRoot.current;
    const { out, layer } = setup(dir);

    const initial = {
      enabled: true,
      device_id: "device-123",
      session_id: "session-123",
      session_last_active: "2026-01-01T00:00:00.000Z",
      distinct_id: "user-123",
      schema_version: 1,
    };

    return Effect.gen(function* () {
      yield* writeTelemetryConfig(dir, initial);
      yield* Command.runWith(legacyTestRoot(), { version: "0.0.0-test" })(["telemetry", "disable"]);
      expect(out.stdoutText).toBe("Telemetry is disabled.\n");
      const config = yield* readTelemetryConfig(dir);
      expect(config.enabled).toBe(false);
      expect(config.device_id).toBe("device-123");
      expect(config.distinct_id).toBe("user-123");
      expect(config.schema_version).toBe(1);
    }).pipe(Effect.provide(layer));
  });

  it.live("status recovers a malformed legacy telemetry.json instead of failing", () => {
    const dir = tempRoot.current;
    const { out, layer } = setup(dir);

    return Effect.gen(function* () {
      yield* writeTelemetryFile(dir, "{not valid json}");
      yield* Command.runWith(legacyTestRoot(), { version: "0.0.0-test" })(["telemetry", "status"]);
      expect(out.stdoutText).toBe("Telemetry is enabled.\n");
      const config = yield* readTelemetryConfig(dir);
      expect(config.enabled).toBe(true);
      expect(config.schema_version).toBe(1);
    }).pipe(Effect.provide(layer));
  });

  // Go parity (`cmd/root.go:131-138,171-181`): `cli_command_executed` is gated on
  // the consent SNAPSHOT taken before the handler runs, not the value the handler
  // just wrote. These two assert the narrower wiring fix using `mockAnalytics()`
  // (which unconditionally records every capture, bypassing consent entirely):
  // `disable`/`enable` no longer force-suppress analytics via `analytics: false`,
  // so the shared instrumentation wrapper actually reaches `Analytics.capture`.
  // The snapshot-timing mechanism itself — that the pre-toggle value survives the
  // handler's own on-disk write — is proven directly against `telemetryRuntimeLayer`
  // in `shared/telemetry/runtime.layer.unit.test.ts`. The two tests further below
  // run the same commands through the REAL, consent-gated `legacyAnalyticsLayer`
  // (not this mock) to prove the production wiring doesn't crash end-to-end.
  it.live("disable no longer force-suppresses cli_command_executed", () => {
    const dir = tempRoot.current;
    const { analytics, layer } = setup(dir);

    return Effect.gen(function* () {
      yield* Command.runWith(legacyTestRoot(), { version: "0.0.0-test" })(["telemetry", "disable"]);
      expect(analytics.captured.map((event) => event.event)).toContain(EventCommandExecuted);
    }).pipe(Effect.provide(layer));
  });

  it.live("enable no longer force-suppresses cli_command_executed", () => {
    const dir = tempRoot.current;
    const { analytics, layer } = setup(dir);

    return Effect.gen(function* () {
      yield* Command.runWith(legacyTestRoot(), { version: "0.0.0-test" })(["telemetry", "enable"]);
      expect(analytics.captured.map((event) => event.event)).toContain(EventCommandExecuted);
    }).pipe(Effect.provide(layer));
  });

  it.live("disable runs cleanly through the real consent-gated analytics layer", () => {
    const dir = tempRoot.current;
    const initial = {
      enabled: true,
      device_id: "device-123",
      session_id: "session-123",
      session_last_active: "2026-01-01T00:00:00.000Z",
      schema_version: 1,
    };
    const { out, layer } = setupWithRealAnalytics(dir);

    return Effect.gen(function* () {
      yield* writeTelemetryConfig(dir, initial);
      yield* Command.runWith(legacyTestRoot(), { version: "0.0.0-test" })(["telemetry", "disable"]);
      expect(out.stdoutText).toBe("Telemetry is disabled.\n");
      expect((yield* readTelemetryConfig(dir)).enabled).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.live("enable runs cleanly through the real consent-gated analytics layer", () => {
    const dir = tempRoot.current;
    const initial = {
      enabled: false,
      device_id: "device-123",
      session_id: "session-123",
      session_last_active: "2026-01-01T00:00:00.000Z",
      schema_version: 1,
    };
    const { out, layer } = setupWithRealAnalytics(dir);

    return Effect.gen(function* () {
      yield* writeTelemetryConfig(dir, initial);
      yield* Command.runWith(legacyTestRoot(), { version: "0.0.0-test" })(["telemetry", "enable"]);
      expect(out.stdoutText).toBe("Telemetry is enabled.\n");
      expect((yield* readTelemetryConfig(dir)).enabled).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "status treats malformed typed fields as a corrupted file and regenerates identity",
    () => {
      const dir = tempRoot.current;
      const { out, layer } = setup(dir);

      const initial = {
        enabled: false,
        device_id: "device-123",
        session_id: "session-123",
        session_last_active: "not-a-time",
        distinct_id: "user-123",
        schema_version: 1,
      };

      return Effect.gen(function* () {
        yield* writeTelemetryConfig(dir, initial);
        yield* Command.runWith(legacyTestRoot(), { version: "0.0.0-test" })([
          "telemetry",
          "status",
        ]);
        expect(out.stdoutText).toBe("Telemetry is enabled.\n");
        const config = yield* readTelemetryConfig(dir);
        expect(config.enabled).toBe(true);
        expect(config.device_id).not.toBe("device-123");
        expect(config.session_id).not.toBe("session-123");
        expect(config.distinct_id).toBeUndefined();
        expect(config.schema_version).toBe(1);
      }).pipe(Effect.provide(layer));
    },
  );
});
