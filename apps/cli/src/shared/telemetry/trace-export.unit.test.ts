import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer, Option, Path, Redacted, Sink, Stdio } from "effect";
import { BunServices } from "@effect/platform-bun";
import { mockRuntimeInfo } from "../../../tests/helpers/mocks.ts";
import { CliSettings } from "../config/cli-settings.service.ts";
import { resolveTraceSettings, withDebugConsole, withTraceExport } from "./trace-export.layer.ts";

const capturedStderr = () => {
  const written: Array<string> = [];
  const sink = Sink.forEach((chunk: string | Uint8Array) =>
    Effect.sync(() => {
      written.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    }),
  );
  return {
    layer: Stdio.layerTest({ stderr: () => sink }),
    text: () => written.join(""),
  };
};

const resolveWithEnv = (env: Readonly<Record<string, string | undefined>>) => {
  const stderr = capturedStderr();
  return resolveTraceSettings.pipe(
    Effect.provide(
      Layer.mergeAll(
        ConfigProvider.layer(ConfigProvider.fromUnknown(env)),
        BunServices.layer,
        stderr.layer,
      ),
    ),
    Effect.map((settings) => ({ settings, stderr: stderr.text() })),
  );
};

describe("resolveTraceSettings", () => {
  it.effect("warns and turns tracing off for a trace file and an OTLP endpoint set together", () =>
    Effect.gen(function* () {
      const { settings, stderr } = yield* resolveWithEnv({
        SUPABASE_TRACE_FILE: "/tmp/trace.jsonl",
        SUPABASE_OTLP_ENDPOINT: "http://localhost:4318",
      });

      expect(settings).toEqual({ sink: Option.none() });
      expect(stderr).toBe(
        "Warning: tracing disabled: SUPABASE_TRACE_FILE and SUPABASE_OTLP_ENDPOINT are both set; choose one trace destination\n",
      );
    }),
  );

  it.effect("resolves a relative trace file against the startup directory", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;

      const { settings } = yield* resolveWithEnv({ SUPABASE_TRACE_FILE: "traces/run.jsonl" });

      expect(Option.getOrThrow(settings.sink)).toEqual({
        _tag: "File",
        path: path.join(process.cwd(), "traces", "run.jsonl"),
      });
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("appends the OTLP traces path to a collector base URL", () =>
    Effect.gen(function* () {
      const { settings } = yield* resolveWithEnv({
        SUPABASE_OTLP_ENDPOINT: "http://localhost:4318/",
        SUPABASE_OTLP_HEADERS: "x-api-key=abc%3D,x-tenant = team",
      });

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
      const { settings } = yield* resolveWithEnv({
        SUPABASE_OTLP_ENDPOINT: "https://otel.example.com/v1/traces",
      });

      expect(Option.getOrThrow(settings.sink)).toMatchObject({
        url: "https://otel.example.com/v1/traces",
      });
    }),
  );

  it.effect.each([
    {
      setting: "endpoint",
      env: { SUPABASE_OTLP_ENDPOINT: "localhost:4318" },
      reason: "SUPABASE_OTLP_ENDPOINT must be an http(s) URL",
    },
    {
      setting: "headers",
      env: { SUPABASE_OTLP_ENDPOINT: "http://localhost:4318", SUPABASE_OTLP_HEADERS: "no-sep" },
      reason: "SUPABASE_OTLP_HEADERS must be a comma-separated list",
    },
    {
      setting: "header name",
      env: { SUPABASE_OTLP_ENDPOINT: "http://localhost:4318", SUPABASE_OTLP_HEADERS: "x%20y=1" },
      reason: "SUPABASE_OTLP_HEADERS must be a comma-separated list",
    },
    {
      setting: "header value",
      env: {
        SUPABASE_OTLP_ENDPOINT: "http://localhost:4318",
        SUPABASE_OTLP_HEADERS: "x-a=1%0D%0Ainjected: yes",
      },
      reason: "SUPABASE_OTLP_HEADERS must be a comma-separated list",
    },
  ])("warns and turns tracing off for invalid collector $setting", ({ env, reason }) =>
    Effect.gen(function* () {
      const { settings, stderr } = yield* resolveWithEnv(env);

      expect(settings).toEqual({ sink: Option.none() });
      expect(stderr).toContain(`Warning: tracing disabled: ${reason}`);
      expect(stderr.split("\n").filter((line) => line.length > 0)).toHaveLength(1);
    }),
  );

  it.effect("is off without a sink or warning, even with SUPABASE_DEBUG set", () =>
    Effect.gen(function* () {
      const { settings, stderr } = yield* resolveWithEnv({ SUPABASE_DEBUG: "1" });

      expect(settings).toEqual({ sink: Option.none() });
      expect(stderr).toBe("");
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
  options: { readonly enclosingRoot?: boolean } = {},
) {
  const stderr = capturedStderr();
  const consoled = withDebugConsole(program);
  yield* (
    options.enclosingRoot === true
      ? consoled.pipe(Effect.withSpan("cli.run"), Effect.withTracerEnabled(true))
      : consoled.pipe(withTraceExport({ sink: Option.none() }, {}))
  ).pipe(
    Effect.provide(
      Layer.mergeAll(BunServices.layer, stderr.layer, mockRuntimeInfo(), debugSettings(debug)),
    ),
  );
  return stderr.text();
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

  it.effect("prints the same spans whether or not a root span encloses the console", () =>
    Effect.gen(function* () {
      const program = Effect.void.pipe(
        Effect.withSpan("Depth.three"),
        Effect.withSpan("Depth.two"),
        Effect.withSpan("Depth.one"),
        Effect.withSpan("Depth.zero"),
      );
      const printedSpans = (output: string) =>
        output
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => line.replace(/^\[[^\]]+\] /u, "").replace(/ \(\d+ms\)/u, ""));

      const standalone = yield* runWithDebugConsole({ debug: "1" }, program);
      const enclosed = yield* runWithDebugConsole({ debug: "1" }, program, {
        enclosingRoot: true,
      });

      expect(printedSpans(standalone)).toEqual(["    Depth.two", "  Depth.one", "Depth.zero"]);
      expect(printedSpans(enclosed)).toEqual(printedSpans(standalone));
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
