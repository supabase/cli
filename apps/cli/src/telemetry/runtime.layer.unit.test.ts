import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect, Layer } from "effect";
import { cliConfigLayer } from "../config/cli-config.layer.ts";
import { TelemetryRuntime } from "./runtime.service.ts";
import { telemetryRuntimeLayer } from "./runtime.layer.ts";
import {
  mockProjectContext,
  mockRuntimeInfo,
  mockTty,
  processEnvLayer,
} from "../../tests/helpers/mocks.ts";

function makeTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "supabase-runtime-test-"));
}

function buildLayer(opts: {
  homeDir: string;
  env?: Record<string, string>;
  stdoutIsTty?: boolean;
}): Layer.Layer<TelemetryRuntime> {
  const runtimeInfoLayer = mockRuntimeInfo({ homeDir: opts.homeDir });
  const projectContextLayer = mockProjectContext();
  const envLayer = processEnvLayer({
    SUPABASE_HOME: opts.homeDir,
    ...opts.env,
  });
  const ttyLayer = mockTty({ stdoutIsTty: opts.stdoutIsTty ?? false });
  const configLayer = cliConfigLayer.pipe(
    Layer.provide(runtimeInfoLayer),
    Layer.provide(projectContextLayer),
  );
  const telemetryLayer = telemetryRuntimeLayer.pipe(
    Layer.provide(configLayer),
    Layer.provide(runtimeInfoLayer),
    Layer.provide(ttyLayer),
    Layer.provide(BunServices.layer),
  );

  return Layer.mergeAll(envLayer, telemetryLayer);
}

describe("telemetryRuntimeLayer", () => {
  it.live("does not create telemetry.json when telemetry is disabled by env on first run", () => {
    const homeDir = makeTempDir();
    const configPath = path.join(homeDir, "telemetry.json");

    return Effect.gen(function* () {
      const runtime = yield* TelemetryRuntime;
      expect(runtime.consent).toBe("denied");
      expect(runtime.isFirstRun).toBe(false);
      expect(existsSync(configPath)).toBe(false);
    }).pipe(
      Effect.provide(
        buildLayer({
          homeDir,
          env: { SUPABASE_TELEMETRY_DISABLED: "1" },
        }),
      ),
      Effect.ensuring(Effect.sync(() => rmSync(homeDir, { recursive: true, force: true }))),
    );
  });

  it.live("marks the actual first granted invocation as first run", () => {
    const homeDir = makeTempDir();
    const configPath = path.join(homeDir, "telemetry.json");

    return Effect.gen(function* () {
      const runtime = yield* TelemetryRuntime;
      expect(runtime.consent).toBe("granted");
      expect(runtime.isFirstRun).toBe(true);
      expect(existsSync(configPath)).toBe(true);
    }).pipe(
      Effect.provide(buildLayer({ homeDir })),
      Effect.ensuring(Effect.sync(() => rmSync(homeDir, { recursive: true, force: true }))),
    );
  });
});
