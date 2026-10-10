import { describe, expect, it } from "@effect/vitest";
import { DateTime, Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { vi } from "vitest";

import { withEnvVar } from "../../tests/helpers/command-mocks.ts";
import { DebugFlag } from "./global-flags.ts";
import { debugLoggerLayer } from "./debug-logger.layer.ts";
import { DebugLogger } from "./debug-logger.service.ts";

function makeLayer(debug: boolean) {
  return debugLoggerLayer.pipe(Layer.provide(Layer.succeed(DebugFlag, debug)));
}

function captureStderr() {
  return vi.spyOn(process.stderr, "write").mockImplementation(() => true);
}

describe("debugLoggerLayer", () => {
  it.effect("does not write stderr bytes when debug is disabled", () => {
    const stderr = captureStderr();
    return Effect.gen(function* () {
      const logger = yield* DebugLogger;
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
      const logger = yield* DebugLogger;
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
    const stderr = captureStderr();
    const body = Effect.gen(function* () {
      const localTime = DateTime.makeZonedUnsafe(
        { year: 2026, month: 6, day: 4, hour: 8, minute: 24, second: 47 },
        { timeZone: DateTime.zoneMakeLocal(), adjustForTimeZone: true },
      );
      yield* TestClock.setTime(DateTime.toEpochMillis(localTime));
      const logger = yield* DebugLogger;
      yield* logger.http("GET", "https://api.supabase.green/v1/projects");
      expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join("")).toBe(
        "2026/06/04 08:24:47 HTTP GET: https://api.supabase.green/v1/projects\n",
      );
    });
    return withEnvVar("TZ", "Asia/Kolkata", body).pipe(
      Effect.ensuring(Effect.sync(() => stderr.mockRestore())),
      Effect.provide(makeLayer(true)),
    );
  });
});
