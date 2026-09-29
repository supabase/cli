import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer, Option, Redacted, Sink, Stdio } from "effect";
import { BunServices } from "@effect/platform-bun";
import { mockRuntimeInfo } from "../../../tests/helpers/mocks.ts";
import { CliSettings } from "../config/cli-settings.service.ts";
import {
  resolveTraceSettings,
  TraceExportConfigError,
  withDebugConsole,
  withTraceExport,
} from "./trace-export.layer.ts";

const withEnv = (env: Record<string, string>) =>
  Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env)));

describe("resolveTraceSettings", () => {
  it.effect("rejects a trace file and an OTLP endpoint set together", () =>
    Effect.gen(function* () {
      const error = yield* resolveTraceSettings.pipe(
        withEnv({
          SUPABASE_TRACE_FILE: "/tmp/trace.jsonl",
          SUPABASE_OTLP_ENDPOINT: "http://localhost:4318",
        }),
        Effect.flip,
      );

      expect(error).toBeInstanceOf(TraceExportConfigError);
      expect(error.message).toContain("choose one trace destination");
    }),
  );

  it.effect("appends the OTLP traces path to a collector base URL", () =>
    Effect.gen(function* () {
      const settings = yield* resolveTraceSettings.pipe(
        withEnv({
          SUPABASE_OTLP_ENDPOINT: "http://localhost:4318/",
          SUPABASE_OTLP_HEADERS: "x-api-key=abc%3D,x-tenant = team",
        }),
      );

      expect(Option.getOrThrow(settings.sink)).toMatchObject({
        _tag: "Otlp",
        url: "http://localhost:4318/v1/traces",
      });
      const sink = Option.getOrThrow(settings.sink);
      expect(sink._tag === "Otlp" && Redacted.value(sink.headers)).toEqual({
        "x-api-key": "abc=",
        "x-tenant": "team",
      });
    }),
  );

  it.effect("keeps an endpoint that already targets the traces path", () =>
    Effect.gen(function* () {
      const settings = yield* resolveTraceSettings.pipe(
        withEnv({ SUPABASE_OTLP_ENDPOINT: "https://otel.example.com/v1/traces" }),
      );

      expect(Option.getOrThrow(settings.sink)).toMatchObject({
        url: "https://otel.example.com/v1/traces",
      });
    }),
  );

  it.effect("rejects a non-http endpoint", () =>
    Effect.gen(function* () {
      const error = yield* resolveTraceSettings.pipe(
        withEnv({ SUPABASE_OTLP_ENDPOINT: "localhost:4318" }),
        Effect.flip,
      );

      expect(error).toBeInstanceOf(TraceExportConfigError);
    }),
  );

  it.effect("is off without a sink, even with SUPABASE_DEBUG set", () =>
    Effect.gen(function* () {
      const settings = yield* resolveTraceSettings.pipe(withEnv({ SUPABASE_DEBUG: "1" }));

      expect(settings).toEqual({ sink: Option.none() });
    }),
  );
});

const debugSettings = (debug: Partial<Record<"debug" | "telemetryDebug", string>>) =>
  Layer.succeed(
    CliSettings,
    CliSettings.of({
      apiUrl: "https://api.supabase.com",
      dashboardUrl: "https://supabase.com/dashboard",
      projectHost: "supabase.co",
      telemetryPosthogHost: "https://eu.i.posthog.com",
      telemetryPosthogKey: Option.none(),
      accessToken: Option.none(),
      noKeyring: Option.none(),
      supabaseHome: "/tmp/supabase-cli-test-home",
      debug: Option.fromUndefinedOr(debug.debug),
      telemetryDebug: Option.fromUndefinedOr(debug.telemetryDebug),
      telemetryDisabled: Option.none(),
      doNotTrack: Option.none(),
    }),
  );

const runWithDebugConsole = Effect.fnUntraced(function* (
  debug: Partial<Record<"debug" | "telemetryDebug", string>>,
  program: Effect.Effect<void>,
) {
  const written: Array<string> = [];
  const stderr = Sink.forEach((chunk: string | Uint8Array) =>
    Effect.sync(() => {
      written.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    }),
  );
  yield* program.pipe(
    withDebugConsole,
    withTraceExport({ sink: Option.none() }, {}),
    Effect.provide(
      Layer.mergeAll(
        BunServices.layer,
        Stdio.layerTest({ stderr: () => stderr }),
        mockRuntimeInfo(),
        debugSettings(debug),
      ),
    ),
  );
  return written.join("");
});

describe("withDebugConsole", () => {
  it.effect("prints spans up to depth 2 and deeper failures, sanitized", () =>
    Effect.gen(function* () {
      const program = Effect.void.pipe(
        Effect.withSpan("Depth.three"),
        Effect.andThen(
          Effect.fail("boom").pipe(Effect.withSpan("Depth.threeFailed"), Effect.ignore),
        ),
        Effect.withSpan("Depth.two"),
        Effect.withSpan("Depth.one", {
          attributes: { "url.full": "https://api.supabase.com/v1/projects?token=abc" },
        }),
        Effect.withSpan("Depth.zero"),
      );

      const output = yield* runWithDebugConsole({ debug: "1" }, program);

      expect(output).toContain("Depth.zero");
      expect(output).toContain("Depth.one");
      expect(output).toContain("Depth.two");
      expect(output).toContain("Depth.threeFailed (");
      expect(output).toContain("failed");
      expect(output).not.toContain("Depth.three (");
      expect(output).not.toContain("token=abc");
      expect(output).not.toContain("boom");
    }),
  );

  it.effect("prints spans for SUPABASE_TELEMETRY_DEBUG=1", () =>
    Effect.gen(function* () {
      const output = yield* runWithDebugConsole(
        { telemetryDebug: "1" },
        Effect.void.pipe(Effect.withSpan("Probe.span")),
      );

      expect(output).toContain("Probe.span");
    }),
  );

  it.effect("prints nothing unless a debug setting is exactly 1", () =>
    Effect.gen(function* () {
      const output = yield* runWithDebugConsole(
        { debug: "true", telemetryDebug: "0" },
        Effect.void.pipe(Effect.withSpan("Probe.span")),
      );

      expect(output).toBe("");
    }),
  );
});
