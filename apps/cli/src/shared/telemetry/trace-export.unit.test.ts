import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer, Option, Redacted, Sink, Stdio } from "effect";
import { BunServices } from "@effect/platform-bun";
import { mockRuntimeInfo } from "../../../tests/helpers/mocks.ts";
import {
  debugFlagEnabled,
  resolveTraceSettings,
  TraceExportConfigError,
  withTraceExport,
} from "./trace-export.layer.ts";

const withEnv = (env: Record<string, string>) =>
  Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env)));

describe("resolveTraceSettings", () => {
  it.effect("rejects a trace file and an OTLP endpoint set together", () =>
    Effect.gen(function* () {
      const error = yield* resolveTraceSettings([]).pipe(
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
      const settings = yield* resolveTraceSettings([]).pipe(
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
      const settings = yield* resolveTraceSettings([]).pipe(
        withEnv({ SUPABASE_OTLP_ENDPOINT: "https://otel.example.com/v1/traces" }),
      );

      expect(Option.getOrThrow(settings.sink)).toMatchObject({
        url: "https://otel.example.com/v1/traces",
      });
    }),
  );

  it.effect("rejects a non-http endpoint", () =>
    Effect.gen(function* () {
      const error = yield* resolveTraceSettings([]).pipe(
        withEnv({ SUPABASE_OTLP_ENDPOINT: "localhost:4318" }),
        Effect.flip,
      );

      expect(error).toBeInstanceOf(TraceExportConfigError);
    }),
  );

  it.effect("is off without a sink or debug switch", () =>
    Effect.gen(function* () {
      const settings = yield* resolveTraceSettings(["projects", "list"]).pipe(withEnv({}));

      expect(settings).toEqual({ sink: Option.none(), debugConsole: false });
    }),
  );

  it.effect("enables the console from SUPABASE_DEBUG", () =>
    Effect.gen(function* () {
      const settings = yield* resolveTraceSettings([]).pipe(withEnv({ SUPABASE_DEBUG: "1" }));

      expect(settings.debugConsole).toBe(true);
    }),
  );
});

describe("debugFlagEnabled", () => {
  it.each([
    [["--debug"], true],
    [["--debug", "--debug=false"], false],
    [["--debug=false", "--debug"], true],
    [["db", "push", "--", "--debug"], undefined],
    [["db", "push"], undefined],
  ] as const)("reads %j as %s", (args, expected) => {
    expect(debugFlagEnabled(args)).toBe(expected);
  });
});

describe("debug console", () => {
  it.effect("prints spans up to depth 2 and deeper failures, sanitized", () =>
    Effect.gen(function* () {
      const written: Array<string> = [];
      const stderr = Sink.forEach((chunk: string | Uint8Array) =>
        Effect.sync(() => {
          written.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
        }),
      );
      const program = Effect.void.pipe(
        Effect.withSpan("Depth.four"),
        Effect.andThen(
          Effect.fail("boom").pipe(Effect.withSpan("Depth.fourFailed"), Effect.ignore),
        ),
        Effect.withSpan("Depth.three"),
        Effect.withSpan("Depth.two", {
          attributes: { "url.full": "https://api.supabase.com/v1/projects?token=abc" },
        }),
        Effect.withSpan("Depth.one"),
      );

      yield* withTraceExport(
        { sink: Option.none(), debugConsole: true },
        {},
      )(program).pipe(
        Effect.provide(
          Layer.mergeAll(
            BunServices.layer,
            Stdio.layerTest({ stderr: () => stderr }),
            mockRuntimeInfo(),
          ),
        ),
      );

      const output = written.join("");
      expect(output).toContain("cli.run");
      expect(output).toContain("Depth.one");
      expect(output).toContain("Depth.two");
      expect(output).toContain("Depth.fourFailed");
      expect(output).toContain("failed");
      expect(output).not.toContain("Depth.three");
      expect(output).not.toContain("Depth.four ");
      expect(output).not.toContain("token=abc");
    }),
  );
});
