import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { afterEach, vi } from "vitest";

import { LegacyDebugFlag } from "../../shared/legacy/global-flags.ts";
import { legacyDebugLoggerLayer } from "./legacy-debug-logger.layer.ts";
import { LegacyDebugLogger } from "./legacy-debug-logger.service.ts";

function makeLayer(debug: boolean) {
  return legacyDebugLoggerLayer.pipe(Layer.provide(Layer.succeed(LegacyDebugFlag, debug)));
}

function captureStderr() {
  return vi.spyOn(process.stderr, "write").mockImplementation(() => true);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("legacyDebugLoggerLayer", () => {
  it.effect("does not write stderr bytes when debug is disabled", () => {
    const stderr = captureStderr();
    return Effect.gen(function* () {
      const logger = yield* LegacyDebugLogger;
      yield* logger.debug("hidden");
      yield* logger.http("GET", "https://api.supabase.green/v1/projects");
      expect(stderr).not.toHaveBeenCalled();
    }).pipe(
      Effect.ensuring(Effect.sync(() => stderr.mockRestore())),
      Effect.provide(makeLayer(false)),
    );
  });

  it.effect("debug emits the exact newline-terminated message", () => {
    const stderr = captureStderr();
    return Effect.gen(function* () {
      const logger = yield* LegacyDebugLogger;
      yield* logger.debug("Using profile: supabase-staging (supabase.red)");
      expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join("")).toBe(
        "Using profile: supabase-staging (supabase.red)\n",
      );
    }).pipe(
      Effect.ensuring(Effect.sync(() => stderr.mockRestore())),
      Effect.provide(makeLayer(true)),
    );
  });

  it.effect("http emits Go timestamp order and method/url format", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 4, 8, 24, 47));
    const stderr = captureStderr();
    return Effect.gen(function* () {
      const logger = yield* LegacyDebugLogger;
      yield* logger.http("GET", "https://api.supabase.green/v1/projects");
      expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join("")).toBe(
        "2026/06/04 08:24:47 HTTP GET: https://api.supabase.green/v1/projects\n",
      );
    }).pipe(
      Effect.ensuring(Effect.sync(() => stderr.mockRestore())),
      Effect.provide(makeLayer(true)),
    );
  });
});
